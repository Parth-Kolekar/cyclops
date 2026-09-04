/**
 * Cyclops service worker — orchestration.
 *
 * Owns the agent loop:
 *   extract (content) -> plan (server) -> execute (content) -> repeat
 *
 * Phase 0: no capture, no redaction, no vault. The graph goes to the server
 * as-is. Phase 2 inserts the sanitiser between extract and plan.
 */

import { ENDPOINTS, MAX_STEPS, MSG } from '../lib/config.js';

/**
 * Bump when the content-script protocol changes. A tab still running an older
 * build answers PING with a different version and gets re-injected, which is
 * the cure for the "I changed the code and nothing happened" failure.
 */
const CONTENT_VERSION = 2;

/** Must match the content_scripts order in manifest.json. */
const CONTENT_FILES = [
  'src/content/extractor.js',
  'src/content/executor.js',
  'src/content/overlay.js',
  'src/content/index.js',
];

let running = false;
let sessionId = null;

/** Fire-and-forget UI updates. The popup may be closed; that's fine. */
function trace(entry) {
  chrome.runtime.sendMessage({ type: MSG.TRACE, entry }).catch(() => {});
}

function status(state, detail) {
  chrome.runtime.sendMessage({ type: MSG.STATUS, state, detail }).catch(() => {});
}

/** Content scripts don't exist on tabs that were open before install. */
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
      const t0 = performance.now();

      const res = await chrome.tabs.sendMessage(tab.id, { type: MSG.EXTRACT });
      if (!res?.ok) throw new Error('extraction failed');
      const graph = res.graph;
      const tExtract = performance.now() - t0;

      trace({
        kind: 'perceive',
        text: `${graph.page.kind} page · ${graph.elements.length} elements` +
              (graph.opaque_regions.length ? ` · ${graph.opaque_regions.length} opaque` : ''),
        ms: Math.round(tExtract),
      });

      status('planning', `step ${step + 1}`);
      const t1 = performance.now();

      // Phase 2 inserts the sanitiser here: tokenise PII, redact the frame,
      // attach the redaction manifest. Today the graph goes as-is.
      const payload = {
        schema: 'cyclops.payload.v1',
        session_id: sessionId,
        step,
        goal,
        history: history.slice(-5),
        page: graph.page,
        viewport: graph.viewport,
        elements: graph.elements,
        opaque_regions: graph.opaque_regions,
        needs_pixels: false,
      };

      const resp = await fetch(ENDPOINTS.plan, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) throw new Error(`server ${resp.status}: ${await resp.text()}`);
      const plan = await resp.json();
      const tNet = performance.now() - t1;

      const action = plan.steps?.[0];
      if (!action) throw new Error('server returned an empty plan');

      trace({
        kind: 'plan',
        text: `${action.action}${action.target ? ` → ${action.target}` : ''} — ${action.reason || ''}`,
        ms: Math.round(tNet),
      });

      if (action.action === 'done') {
        trace({ kind: 'done', text: action.summary || 'task complete' });
        status('idle', 'done');
        break;
      }

      status('acting', `step ${step + 1}`);
      const t2 = performance.now();
      const result = await chrome.tabs.sendMessage(tab.id, { type: MSG.EXECUTE, action });
      const tAct = performance.now() - t2;

      trace({
        kind: result.ok ? 'act' : 'error',
        text: result.ok ? result.note : result.error,
        ms: Math.round(tAct),
      });

      history.push({ action, ok: !!result.ok, note: result.note || result.error });

      if (result.halt) { status('idle', 'waiting on user'); break; }

      // let the page settle before the next capture
      await new Promise((r) => setTimeout(r, 400));
    }
  } catch (err) {
    trace({ kind: 'error', text: String(err.message || err) });
    status('idle', 'error');
  } finally {
    running = false;
    status('idle', null);
  }
}

/**
 * Scan the page and draw the overlay, without running the agent. This is the
 * "show me what you see" button — the visual proof behind the perception
 * accuracy claim.
 */
async function inspect(show) {
  const tab = await getActiveTab();
  await ensureContentScript(tab.id);
  const res = await chrome.tabs.sendMessage(tab.id, { type: MSG.INSPECT, show });
  if (!res) {
    throw new Error(
      'the page is running an old content script — reload the tab (Ctrl+R)'
    );
  }
  if (!res.ok) throw new Error(res.error || 'inspect failed');
  await chrome.storage.session.set({ lastGraph: res.graph });
  return res.graph;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === MSG.RUN_GOAL) {
    runGoal(msg.goal);
    sendResponse({ ok: true });
  } else if (msg.type === MSG.STOP) {
    running = false;
    sendResponse({ ok: true });
  } else if (msg.type === MSG.INSPECT) {
    inspect(msg.show)
      .then((graph) => sendResponse({ ok: true, graph }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;   // async response
  } else {
    // Never drop a message silently — an unanswered sendMessage resolves to
    // `undefined` in the caller, which is impossible to debug. Usually means
    // a stale service worker after a code change.
    sendResponse({ ok: false, error: `service worker does not handle "${msg.type}" — reload the extension` });
  }
  return false;
});
