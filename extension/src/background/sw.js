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

import { ENDPOINTS, MAX_STEPS, MSG } from '../lib/config.js';
import { auditPayload, sanitise } from '../lib/sanitise.js';
import * as vault from '../lib/vault.js';

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
  'src/content/executor.js',
  'src/content/overlay.js',
  'src/content/index.js',
];

let running = false;
let sessionId = null;

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

async function getActiveTab() {
  // `currentWindow` is unreliable from a service worker — it has no window of
  // its own. `lastFocusedWindow` is the one the user is actually looking at.
  let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('no active tab');
  if (/^(chrome|edge|about|chrome-extension):/.test(tab.url || '')) {
    throw new Error('cannot run on browser-internal pages — open the demo page first');
  }
  return tab;
}

/** Perceive the page and turn it into something safe to send. */
async function perceive(tabId, { goal, step, history }) {
  const t0 = performance.now();
  const res = await chrome.tabs.sendMessage(tabId, { type: MSG.EXTRACT });
  if (!res) throw new Error('the page is running an old content script — reload the tab (Ctrl+R)');
  if (!res.ok) throw new Error(res.error || 'extraction failed');
  const graph = res.graph;
  const perceiveMs = performance.now() - t0;

  const t1 = performance.now();
  const { elements, manifest, findings, assignments } = await sanitise(graph);
  const sanitiseMs = performance.now() - t1;

  const payload = {
    schema: 'cyclops.payload.v2',
    session_id: sessionId,
    step,
    goal,
    history,
    page: graph.page,
    viewport: graph.viewport,
    elements,
    opaque_regions: graph.opaque_regions,
    redaction_manifest: manifest,
    needs_pixels: false,
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
    lastFindings: findings.map((f) => ({ ...f, token: assignments[`${f.kind} ${f.value}`] })),
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

async function runGoal(goal) {
  if (running) return;
  running = true;
  sessionId = crypto.randomUUID();

  const history = [];

  try {
    const tab = await getActiveTab();
    await ensureContentScript(tab.id);

    for (let step = 0; step < MAX_STEPS && running; step++) {
      status('perceiving', `step ${step + 1}`);

      const { graph, payload, findings, perceiveMs, sanitiseMs } =
        await perceive(tab.id, { goal, step, history: history.slice(-5) });

      trace({
        kind: 'perceive',
        text: `${graph.page.kind} page · ${graph.elements.length} elements` +
              (graph.opaque_regions.length ? ` · ${graph.opaque_regions.length} opaque` : ''),
        ms: Math.round(perceiveMs),
      });

      if (findings.length) {
        const kinds = [...new Set(findings.map((f) => f.kind))].join(', ');
        trace({
          kind: 'redact',
          text: `${findings.length} PII tokenised (${kinds}) · 0 leaked`,
          ms: Math.round(sanitiseMs),
        });
      }

      status('planning', `step ${step + 1}`);
      const t1 = performance.now();

      // Counted here, not in perceive() — a preview from the popup builds a
      // payload but never sends one, and the slide says "payloads sent".
      STATS.payloads += 1;
      STATS.pii_tokenised += findings.length;

      const resp = await fetch(ENDPOINTS.plan, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) throw new Error(`server ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      const plan = await resp.json();
      const netMs = performance.now() - t1;

      const raw = plan.steps?.[0];
      if (!raw) throw new Error('server returned an empty plan');

      trace({
        kind: 'plan',
        text: `${raw.action}${raw.target ? ` → ${raw.target}` : ''} — ${raw.reason || ''}`,
        ms: Math.round(netMs),
      });

      if (raw.action === 'done') {
        trace({ kind: 'done', text: raw.summary || 'task complete' });
        break;
      }

      const { action, blocked, token, kind } = await rehydrate(raw, payload.elements);
      if (blocked) {
        // Vault rule 2 caught it. This is a feature, and it is loud on purpose.
        trace({ kind: 'blocked', text: blocked });
        history.push({ action: raw, ok: false, note: blocked });
        continue;
      }
      if (token) {
        trace({ kind: 'vault', text: `${token} resolved locally — the server never saw this ${kind}` });
      }

      status('acting', `step ${step + 1}`);
      const t2 = performance.now();
      const result = await chrome.tabs.sendMessage(tab.id, { type: MSG.EXECUTE, action });
      const actMs = performance.now() - t2;

      trace({
        kind: result.ok ? 'act' : 'error',
        // Never echo a rehydrated value into the trace.
        text: result.ok ? result.note : result.error,
        ms: Math.round(actMs),
      });

      history.push({ action: raw, ok: !!result.ok, note: result.note || result.error });

      if (result.halt) { status('idle', 'waiting on user'); break; }

      // let the page settle before the next capture
      await new Promise((r) => setTimeout(r, 400));
    }
  } catch (err) {
    trace({ kind: 'error', text: String(err.message || err) });
  } finally {
    running = false;
    status('idle', null);
  }
}

/**
 * Scan the page and draw the overlay, without running the agent. This is the
 * "show me what you see" button — the visual proof behind both the perception
 * accuracy claim and the redaction claim.
 */
async function inspect(mode = 'graph') {
  const tab = await getActiveTab();
  await ensureContentScript(tab.id);

  if (!sessionId) sessionId = crypto.randomUUID();
  const { graph, payload, findings, assignments } =
    await perceive(tab.id, { goal: '', step: 0, history: [] });

  // Attach the tokens so the boxes on screen are labelled with the same
  // placeholders the server will receive.
  const annotated = {
    ...graph,
    pii: {
      ...graph.pii,
      findings: findings.map((f) => ({ ...f, token: assignments[`${f.kind} ${f.value}`] })),
    },
  };

  await chrome.tabs.sendMessage(tab.id, { type: MSG.OVERLAY_SHOW, graph: annotated, mode });
  return { graph: annotated, payload, stats: STATS };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === MSG.RUN_GOAL) {
    runGoal(msg.goal);
    sendResponse({ ok: true });
  } else if (msg.type === MSG.STOP) {
    running = false;
    sendResponse({ ok: true });
  } else if (msg.type === MSG.INSPECT) {
    inspect(msg.mode)
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
