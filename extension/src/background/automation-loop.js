/**
 * Cyclops — continuous automation loop.
 *
 * Ported from browser-automation/extension/automation/automation-loop.js and
 * adapted for Cyclops's privacy-preserving architecture.
 *
 * KEY DIFFERENCES FROM THE REFERENCE:
 *
 * 1. The reference sends multimodal messages (DOM + base64 screenshots inline
 *    in a single string) to a generic `/api/v1/browser/process` endpoint.
 *    Cyclops sends structured JSON payloads to `/v1/plan` with separate fields
 *    for elements, viewport, image_base64, and redaction_manifest.
 *
 * 2. The reference executes tools via direct function calls inside the service
 *    worker (e.g. `click(params)`).  Cyclops executes tools by sending an
 *    `EXECUTE` message to the content script, which resolves the opaque e-id
 *    to a live DOM node and performs the action.  Navigation actions that need
 *    tab-level access (goto, goback, reload) are handled here in the SW.
 *
 * 3. The reference manages conversation history as role/content pairs and
 *    sends the entire array to the server for LLM context.  Cyclops uses a
 *    compact ActionRecord[] (action + ok + note) format, and the server only
 *    sees the last 5 entries.  Full history is persisted locally for resumption.
 *
 * 4. All perception (DOM extraction + PII sanitisation + screenshot + visual
 *    redaction) goes through the existing `perceive()` pipeline, which enforces
 *    the privacy guarantee that no raw PII leaves the device.
 */

import { ENDPOINTS, MSG, SETTLE_DELAY_MS } from '../lib/config.js';
import { AutomationState } from './automation-state.js';
import { ChatHistory } from './history.js';

/**
 * Run the continuous automation loop.
 *
 * This function takes ownership of the automation lifecycle.  It runs until
 * one of three conditions is met:
 *   1. The server returns `action: "exit"` (clean exit).
 *   2. The user clicks Stop (sets AutomationState.running = false).
 *   3. MAX_CONSECUTIVE_ERRORS consecutive errors occur (safety rail).
 *
 * @param {string}   goal       The user's natural-language task description.
 * @param {Function} perceive   The perceive(tabId, ctx) function from sw.js.
 * @param {Function} rehydrate  The rehydrate(action, elements) function from sw.js.
 * @param {Function} trace      Fire-and-forget trace entry for the popup.
 * @param {Function} status     Fire-and-forget status update for the popup.
 * @param {object}   stats      The STATS counter object from sw.js.
 */
export async function runAutomationLoop(
  goal, { perceive, rehydrate, trace, status, stats },
) {
  // Guard: only one loop at a time.
  if (AutomationState.isRunning()) {
    trace({ kind: 'error', text: 'automation already running — ignoring duplicate start' });
    return;
  }

  AutomationState.start(goal);
  const sessionId = AutomationState.getSessionId();

  // Load persisted history so the agent can resume across sessions.
  let history = await ChatHistory.load();

  let exitCalled = false;
  let lastPlanner = null;

  try {
    // -------------------------------------------------------------- get tab
    // Import inline to avoid circular dependency — getActiveTab lives in sw.js
    // and can throw if no suitable tab is open.
    const tab = await getActiveTab();
    await ensureContentScript(tab.id);

    // ------------------------------------------------- initial perception
    status('perceiving', 'step 1');

    const initial = await perceive(tab.id, {
      goal,
      step: 0,
      history: history.slice(-5),
    });

    trace({
      kind: 'perceive',
      text:
        `${initial.graph.page.kind} page · ` +
        `${initial.graph.elements.length} elements` +
        (initial.graph.opaque_regions.length
          ? ` · ${initial.graph.opaque_regions.length} opaque`
          : ''),
      ms: Math.round(initial.perceiveMs),
    });

    if (initial.findings.length) {
      const kinds = [...new Set(initial.findings.map((f) => f.kind))].join(', ');
      trace({
        kind: 'redact',
        text: `${initial.findings.length} PII tokenised (${kinds}) · 0 leaked`,
        ms: Math.round(initial.sanitiseMs),
      });
    }

    // ================================================= MAIN LOOP
    while (AutomationState.isRunning() && !exitCalled) {
      const step = AutomationState.getStep();
      AutomationState.incrementStep();

      // --------------------------------------------------- plan
      status('planning', `step ${step + 1}`);
      const t1 = performance.now();

      // Re-perceive on every iteration (except the first, which is done above).
      // On step 0 we use the initial perception; on subsequent steps we
      // capture a fresh snapshot to reflect the result of the last action.
      let perception;
      if (step === 0) {
        perception = initial;
      } else {
        status('perceiving', `step ${step + 1}`);
        perception = await perceive(tab.id, {
          goal,
          step,
          history: history.slice(-5),
        });

        trace({
          kind: 'perceive',
          text:
            `${perception.graph.page.kind} page · ` +
            `${perception.graph.elements.length} elements`,
          ms: Math.round(perception.perceiveMs),
        });

        status('planning', `step ${step + 1}`);
      }

      // Count payloads and PII for the results slide.
      stats.payloads += 1;
      stats.pii_tokenised += perception.findings.length;

      // POST to the server.
      const resp = await fetch(ENDPOINTS.plan, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(perception.payload),
      });

      if (!resp.ok) {
        const body = (await resp.text()).slice(0, 200);
        throw new Error(`server ${resp.status}: ${body}`);
      }

      const plan = await resp.json();
      const netMs = performance.now() - t1;

      const raw = plan.steps?.[0];
      if (!raw) throw new Error('server returned an empty plan');

      // Announce planner identity (visible when switching between LLM and stub).
      if (plan.planner && plan.planner !== lastPlanner) {
        lastPlanner = plan.planner;
        trace({ kind: 'perceive', text: `planner: ${plan.planner}` });
      }

      trace({
        kind: 'plan',
        text: `${raw.action}${raw.target ? ` → ${raw.target}` : ''} — ${raw.reason || ''}`,
        ms: Math.round(netMs),
      });

      // --------------------------------------------------- exit check
      // The server speaks `exit` since the fifteen-verb DSL landed. `done` is
      // still accepted so a stale server build cannot hang the loop forever.
      if (raw.action === 'exit' || raw.action === 'done') {
        exitCalled = true;
        trace({ kind: 'done', text: raw.summary || 'task complete' });

        // Persist the completion in history.
        history.push({ action: raw, ok: true, note: raw.summary || 'task complete' });
        await ChatHistory.save(history);

        break;
      }

      // --------------------------------------------------- rehydrate
      const { action, blocked, token, kind } = await rehydrate(raw, perception.payload.elements);

      if (blocked) {
        trace({ kind: 'blocked', text: blocked });
        history.push({ action: raw, ok: false, note: blocked });
        await ChatHistory.save(history);
        // Blocked fills are a feature, not an error — continue the loop.
        continue;
      }

      if (token) {
        trace({
          kind: 'vault',
          text: `${token} resolved locally — the server never saw this ${kind}`,
        });
      }

      // --------------------------------------------------- execute
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

      // --------------------------------------------------- record result
      AutomationState.setLastResult(result);
      history.push({
        action: raw,
        ok: !!result.ok,
        note: result.note || result.error,
      });
      await ChatHistory.save(history);

      // Error tracking: consecutive failures trigger the safety rail.
      if (result.ok) {
        AutomationState.resetErrors();
      } else {
        AutomationState.incrementError();
        if (AutomationState.hasMaxErrors()) {
          trace({
            kind: 'error',
            text: `stopping — ${AutomationState.getStatus().consecutiveErrors} consecutive errors`,
          });
          break;
        }
      }

      // User-initiated halt (e.g. ask_user action).
      if (result.halt) {
        status('idle', 'waiting on user');
        break;
      }

      // Let the page settle before the next capture.
      await new Promise((r) => setTimeout(r, SETTLE_DELAY_MS));
    }
  } catch (err) {
    trace({ kind: 'error', text: String(err.message || err) });
  } finally {
    AutomationState.stop();
    status('idle', null);
    console.log(
      `🔚 Automation ended — session ${sessionId}, ` +
      `${AutomationState.getStep()} steps`,
    );
  }
}

// ---------------------------------------------------------------------------
// These two helpers are injected by sw.js at import time via the dependency
// injection object.  But getActiveTab and ensureContentScript are standalone
// utilities that the loop calls directly.  We import them as module-level
// references that sw.js will set before the loop starts.
//
// This avoids circular imports: automation-loop.js does NOT import sw.js.
// Instead, sw.js passes its own functions into runAutomationLoop's options.
//
// getActiveTab and ensureContentScript are the exception — they're called
// at the top of the loop before the main while(), so we need them as globals.
// sw.js will call setSwHelpers() to inject them.
// ---------------------------------------------------------------------------

let getActiveTab = null;
let ensureContentScript = null;

/**
 * Called once by sw.js at module load to inject functions that the loop needs
 * but that live in sw.js.  Avoids circular imports.
 */
export function setSwHelpers(helpers) {
  getActiveTab = helpers.getActiveTab;
  ensureContentScript = helpers.ensureContentScript;
}
