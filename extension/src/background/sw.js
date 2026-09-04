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
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content/index.js'],
    });
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
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
        text: `saw ${graph.elements.length} elements on "${graph.page.title}"`,
        ms: Math.round(tExtract),
      });

      status('planning', `step ${step + 1}`);
      const t1 = performance.now();

      const payload = {
        schema: 'cyclops.payload.v0',
        session_id: sessionId,
        step,
        goal,
        history: history.slice(-5),
        page: graph.page,
        viewport: graph.viewport,
        elements: graph.elements,
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

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === MSG.RUN_GOAL) {
    runGoal(msg.goal);
  } else if (msg.type === MSG.STOP) {
    running = false;
  }
  return false;
});
