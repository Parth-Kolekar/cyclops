/**
 * Cyclops — automation state manager.
 *
 * Centralises all mutable automation state so the service worker message
 * handler, the automation loop, and the popup status query can coordinate
 * through a single source of truth instead of scattered `let` variables.
 *
 * Ported & simplified from browser-automation/extension/automation/automation-state.js.
 * The reference version carries logs and conversation history inside the state
 * object; we keep those responsibilities in their own modules (trace → popup
 * session storage, history → ChatHistory) to avoid coupling.
 */

import { MAX_CONSECUTIVE_ERRORS } from '../lib/config.js';

const state = {
  running: false,
  sessionId: null,
  goal: null,
  step: 0,
  consecutiveErrors: 0,
  lastResult: null,
};

export const AutomationState = {
  // ------------------------------------------------------------ lifecycle

  /** Begin a new automation run.  Resets all counters. */
  start(goal) {
    state.running = true;
    state.sessionId = crypto.randomUUID();
    state.goal = goal;
    state.step = 0;
    state.consecutiveErrors = 0;
    state.lastResult = null;
  },

  /** Halt the current run (called by the loop on exit, or by the user). */
  stop() {
    state.running = false;
  },

  /** @returns {boolean} */
  isRunning() {
    return state.running;
  },

  // ---------------------------------------------------------- step tracking

  incrementStep() {
    state.step++;
  },

  setLastResult(result) {
    state.lastResult = result;
  },

  // --------------------------------------------------------- error tracking

  incrementError() {
    state.consecutiveErrors++;
  },

  resetErrors() {
    state.consecutiveErrors = 0;
  },

  /** @returns {boolean} true when the loop should give up */
  hasMaxErrors() {
    return state.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS;
  },

  // --------------------------------------------------------------- queries

  /** @returns {string|null} */
  getSessionId() {
    return state.sessionId;
  },

  /** @returns {string|null} */
  getGoal() {
    return state.goal;
  },

  /** @returns {number} */
  getStep() {
    return state.step;
  },

  /**
   * Snapshot suitable for sending to the popup or for diagnostic logging.
   * Never includes result payloads — those can be large.
   */
  getStatus() {
    return {
      running: state.running,
      sessionId: state.sessionId,
      goal: state.goal,
      step: state.step,
      consecutiveErrors: state.consecutiveErrors,
    };
  },

  /** Full reset — useful when clearing extension state. */
  reset() {
    state.running = false;
    state.sessionId = null;
    state.goal = null;
    state.step = 0;
    state.consecutiveErrors = 0;
    state.lastResult = null;
  },
};
