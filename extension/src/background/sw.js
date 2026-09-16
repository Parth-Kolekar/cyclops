/**
 * Cyclops service worker — orchestration.
 *
 * Owns the agent loop:
 *   extract -> detect PII -> sanitise -> plan (server) -> rehydrate -> execute
 *
 * The vault lives here and only here. Real PII values are never sent to the
 * content script except at the instant one is typed into a field that has been
 * independently verified as being for that kind of data.
 */

import { ENDPOINTS, MSG } from '../lib/config.js';
import { auditPayload, sanitise } from '../lib/sanitise.js';
import * as vault from '../lib/vault.js';
import { AutomationState } from './automation-state.js';
import { runAutomationLoop, setSwHelpers } from './automation-loop.js';
// Still needed here for the popup's "clear history" command; the loop itself
// loads and saves through its own import.
import { ChatHistory } from './history.js';

/**
 * Bump when the content-script protocol changes. A tab still running an older
 * build answers PING with a different version and gets re-injected, which is
 * the cure for the "I changed the code and nothing happened" failure.
 */
const CONTENT_VERSION = 3;

/** Must match the content_scripts order in manifest.json. */
const CONTENT_FILES = [
  'src/content/extractor.js',
  'src/content/pii.js',
  'dist/content/executor.js',
  'src/content/overlay.js',
  'src/content/index.js',
];

// State management is now centralised in AutomationState.
// The `running` and `sessionId` variables are no longer needed here.

/** Counters for the results slide. */
const STATS = { payloads: 0, pii_tokenised: 0, leaks_blocked: 0, fills_refused: 0 };

/** Fire-and-forget UI updates. The popup may be closed; that's fine. */
function trace(entry) {
  chrome.runtime.sendMessage({ type: MSG.TRACE, entry }).catch(() => {});
}

function status(state, detail) {
  chrome.runtime.sendMessage({ type: MSG.STATUS, state, detail }).catch(() => {});
}

async function ensureContentScript(tabId) {
  let alive = false;
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    alive = pong?.ok === true && pong.version === CONTENT_VERSION;
  } catch {
    alive = false;   // no listener at all
  }
  if (alive) return;

  // Either nothing is injected, or what's there is from an older build.
  await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
}

const INTERNAL_PAGE_RE = /^(chrome|edge|about|chrome-extension):/;

/**
 * Every goal starts from the same known page. Two reasons, not one:
 *
 *   1. A blank New Tab page has nothing for a content script to attach to,
 *      and Chrome refuses injection there outright — this used to be a hard
 *      "open the demo page first" error.
 *   2. A fixed, known starting point means a goal behaves the same way
 *      whatever tab happened to be in front when Run was clicked, rather
 *      than depending on the page the user forgot they had open.
 *
 * A goal is a destination, not a page to read, so nothing is lost by moving
 * off whatever was on screen — the agent's first `navigate` action was going
 * to take it wherever the goal actually needs anyway.
 */
const BOOTSTRAP_URL = 'https://www.google.com/';

async function waitForLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('timed out waiting for the bootstrap page to load'));
    }, timeoutMs);
    function onUpdated(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function getActiveTab({ bootstrap = false } = {}) {
  // `currentWindow` is unreliable from a service worker — it has no window of
  // its own. `lastFocusedWindow` is the one the user is actually looking at.
  let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('no active tab');

  if (bootstrap) {
    // Unconditional: every goal begins at BOOTSTRAP_URL, not just a rescue
    // for internal pages. Skip the round-trip only if we're already there.
    if (tab.url !== BOOTSTRAP_URL) {
      await chrome.tabs.update(tab.id, { url: BOOTSTRAP_URL });
      await waitForLoad(tab.id);
      [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    }
    return tab;
  }

  if (INTERNAL_PAGE_RE.test(tab.url || '')) {
    throw new Error('cannot run on browser-internal pages — open the demo page first');
  }
  return tab;
}

/** Same guard as getActiveTab, for a tab id supplied by the UI. */
async function resolveTab(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new Error('that tab is gone — reopen settings from the page you want to inspect');
  }
  if (/^(chrome|edge|about|chrome-extension):/.test(tab.url || '')) {
    throw new Error('cannot run on browser-internal pages — open the demo page first');
  }
  return tab;
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL('src/offscreen/vision.html');
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl]
  });
  if (existingContexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: 'src/offscreen/vision.html',
    reasons: ['WORKERS'],
    justification: 'Run ONNX/WebGPU inference for visual redaction'
  });
}

/**
 * Perceive the page and turn it into something safe to send.
 * Exported-by-reference to the automation loop via setSwHelpers().
 */
async function perceive(tabId, { goal, step, history }) {
  const sessionId = AutomationState.getSessionId();
  const t0 = performance.now();
  const res = await chrome.tabs.sendMessage(tabId, { type: MSG.EXTRACT });
  if (!res) throw new Error('the page is running an old content script — reload the tab (Ctrl+R)');
  if (!res.ok) throw new Error(res.error || 'extraction failed');
  const graph = res.graph;
  const extractMs = performance.now() - t0;

  const t1 = performance.now();
  const { elements, page, manifest, findings, assignments } = await sanitise(graph);
  const sanitiseMs = performance.now() - t1;

  // Capture screenshot and redact visually
  let image_base64 = null;
  let screenshotMs = 0;
  let visionMs = 0;
  
  try {
    // Engineer 2: Render the unified overlay (red boxes + DOM black boxes) BEFORE taking the screenshot
    // so the AI actually sees the opaque e-ids it needs to interact with.
    await chrome.tabs.sendMessage(tabId, { type: MSG.OVERLAY_SHOW, graph, mode: 'redact' });
    await new Promise(r => setTimeout(r, 100)); // allow DOM to paint

    const t2 = performance.now();
    const rawScreenshot = await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 80 });
    screenshotMs = performance.now() - t2;
    
    // Hide the overlay immediately so the user can use the page
    await chrome.tabs.sendMessage(tabId, { type: MSG.OVERLAY_HIDE });

    await ensureOffscreenDocument();
    
    const t3 = performance.now();
    const redactRes = await chrome.runtime.sendMessage({
      type: 'REDACT_IMAGE',
      imageUri: rawScreenshot,
      findings: findings,
      viewport: graph.viewport,
      opaque_regions: graph.opaque_regions
    });
    visionMs = performance.now() - t3;
    
    if (redactRes && redactRes.ok) {
      image_base64 = redactRes.imageUri;
    }
  } catch (err) {
    console.error("Screenshot or visual redaction failed:", err);
  }

  const perceiveMs = extractMs + sanitiseMs + screenshotMs + visionMs;

  console.table({
    'DOM Extraction': `${extractMs.toFixed(0)} ms`,
    'DOM Sanitisation': `${sanitiseMs.toFixed(0)} ms`,
    'Screenshot Capture': `${screenshotMs.toFixed(0)} ms`,
    'Visual Redaction (Yolos + OCR)': `${visionMs.toFixed(0)} ms`,
    'Total Perceive': `${perceiveMs.toFixed(0)} ms`
  });

  const payload = {
    schema: 'cyclops.payload.v2',
    // sessionId comes from AutomationState (set at the top of perceive).
    session_id: sessionId,
    step,
    goal,
    history,
    available_vault_tokens: await vault.availableTokens(),
    page,
    viewport: graph.viewport,
    elements,
    opaque_regions: graph.opaque_regions,
    redaction_manifest: manifest,
    needs_pixels: false,
    image_base64
  };

  // Last line of defence before the bytes exist on the wire.
  const leaked = auditPayload(payload, findings);
  if (leaked.length) {
    STATS.leaks_blocked += 1;
    throw new Error(`refusing to send — ${leaked.join(', ')} survived sanitisation`);
  }

  // Keep both sides so the popup can show them next to each other. This is
  // the "here is every byte that left the machine" panel.
  await chrome.storage.session.set({
    lastGraph: graph,
    lastPayload: payload,
    lastFindings: findings.map((f) => ({ ...f, token: assignments[`${f.kind}\0${f.value}`] })),
    stats: STATS,
  });

  return { graph, payload, findings, assignments, perceiveMs, sanitiseMs };
}

/**
 * Turn a server action carrying a placeholder into one carrying the real
 * value — but only if the target field is genuinely for that kind of data.
 */
async function rehydrate(action, elements) {
  if (action.action !== 'fill' || !vault.TOKEN_RE.test(action.value ?? '')) {
    return { action };
  }

  const entry = await vault.resolve(action.value);
  if (!entry) return { blocked: `unknown token ${action.value}` };

  const target = elements.find((e) => e.id === action.target);
  const check = vault.compatible(entry.kind, target);
  if (!check.ok) {
    STATS.fills_refused += 1;
    await chrome.storage.session.set({ stats: STATS });
    return { blocked: `${action.value} refused — ${check.reason}` };
  }

  return { action: { ...action, value: entry.value }, token: action.value, kind: entry.kind };
}

/**
 * Start the continuous automation loop.
 *
 * This thin wrapper replaces the old fixed-step `runGoal()`.  The actual
 * loop logic lives in automation-loop.js and runs until the server returns
 * `action: "exit"`, the user clicks Stop, or too many errors accumulate.
 *
 * Dependencies are injected to avoid circular module imports.
 */
async function startAutomation(goal) {
  if (AutomationState.isRunning()) return;

  // The loop lives in automation-loop.js as of the orchestration port. It
  // loads and persists ChatHistory itself, so nothing here needs to.
  await runAutomationLoop(goal, {
    perceive,
    rehydrate,
    trace,
    status,
    stats: STATS,
  });
}

/**
 * Scan the page and draw the overlay, without running the agent. This is the
 * "show me what you see" button — the visual proof behind both the perception
 * accuracy claim and the redaction claim.
 */
async function inspect(mode = 'graph', tabId = null) {
  // settings.html lives in its own tab, so "the active tab" from there is the
  // settings page itself. It passes the tab that was in front when the gear was
  // clicked, and we inspect that instead.
  const tab = tabId ? await resolveTab(tabId) : await getActiveTab();
  await ensureContentScript(tab.id);

  // perceive() reads the sessionId from AutomationState.  If no automation
  // is running (the normal case for inspect), ensure one exists temporarily.
  const wasRunning = AutomationState.isRunning();
  if (!AutomationState.getSessionId()) {
    AutomationState.start('');   // temporary session for inspect
    AutomationState.stop();      // immediately mark as not running
  }

  const { graph, payload, findings, assignments } =
    await perceive(tab.id, { goal: '', step: 0, history: [] });

  // Attach the tokens so the boxes on screen are labelled with the same
  // placeholders the server will receive.
  const annotated = {
    ...graph,
    pii: {
      ...graph.pii,
      findings: findings.map((f) => ({ ...f, token: assignments[`${f.kind}\0${f.value}`] })),
    },
  };

  await chrome.tabs.sendMessage(tab.id, { type: MSG.OVERLAY_SHOW, graph: annotated, mode });
  return { graph: annotated, payload, stats: STATS };
}

/**
 * The persistent-vault operations. Each is "call one vault function, hand back
 * the new state" — a table keeps the message listener from growing another
 * eight near-identical branches.
 *
 * Every one of these returns the fresh `status`, so the popup never has to
 * guess whether it is now locked or unlocked.
 */
const VAULT_OPS = {
  [MSG.VAULT_STATUS]: async () => ({ status: await vault.status() }),

  [MSG.VAULT_SET_PASS]: async (m) => {
    await vault.setPassphrase(m.passphrase, { rekey: !!m.rekey });
    return { status: await vault.status(), entries: await vault.recall() };
  },

  [MSG.VAULT_UNLOCK]: async (m) => {
    await vault.unlock(m.passphrase);
    return { status: await vault.status(), entries: await vault.recall() };
  },

  [MSG.VAULT_LOCK]: async () => {
    await vault.lock();
    return { status: await vault.status(), entries: await vault.recall() };
  },

  [MSG.VAULT_REMEMBER]: async (m) => {
    const id = await vault.remember(m.kind, m.value, m.label);
    return { id, status: await vault.status(), entries: await vault.recall() };
  },

  [MSG.VAULT_RECALL]: async () => ({
    status: await vault.status(),
    entries: await vault.recall(),
  }),

  [MSG.VAULT_FORGET]: async (m) => {
    await vault.forget(m.id);
    return { status: await vault.status(), entries: await vault.recall() };
  },

  [MSG.VAULT_FORGET_ALL]: async () => {
    await vault.forgetAll();
    return { status: await vault.status(), entries: [] };
  },

  [MSG.HISTORY_CLEAR]: async () => {
    await ChatHistory.clear();
    return {};
  },
};

// Inject helpers that the automation loop needs but that live in this file.
// This avoids circular module imports.
setSwHelpers({ getActiveTab, ensureContentScript });

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (VAULT_OPS[msg.type]) {
    VAULT_OPS[msg.type](msg)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;   // async response
  }

  if (msg.type === MSG.RUN_GOAL) {
    startAutomation(msg.goal);
    sendResponse({ ok: true });
  } else if (msg.type === MSG.STOP) {
    AutomationState.stop();
    sendResponse({ ok: true });
  } else if (msg.type === MSG.INSPECT) {
    inspect(msg.mode, msg.tabId)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;   // async response
  } else if (msg.type === MSG.VAULT_LIST) {
    vault.inspect()
      .then((entries) => sendResponse({ ok: true, entries, stats: STATS }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  } else if (msg.type === MSG.VAULT_CLEAR) {
    vault.clear()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  } else {
    // Never drop a message silently — an unanswered sendMessage resolves to
    // `undefined` in the caller, which is impossible to debug. Usually means
    // a stale service worker after a code change.
    sendResponse({ ok: false, error: `service worker does not handle "${msg.type}" — reload the extension` });
  }
  return false;
});
