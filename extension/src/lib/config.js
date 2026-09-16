// Single source of truth for constants shared across the extension.
// Phase 0: kept deliberately tiny. Grows as the pipeline grows.

export const SERVER_BASE = 'http://localhost:8000';

export const ENDPOINTS = {
  plan: `${SERVER_BASE}/v1/plan`,
  verify: `${SERVER_BASE}/v1/verify`,
  health: `${SERVER_BASE}/v1/health`,
  metrics: `${SERVER_BASE}/v1/metrics`,
};

// Safety rail: stop the loop after N consecutive errors, not after N steps.
// The loop itself runs until the server returns `action: "done"` or the user
// clicks Stop.  This replaces the old MAX_STEPS = 8 cap.
export const MAX_CONSECUTIVE_ERRORS = 3;

// Milliseconds to wait after executing an action before the next perception.
// Lets the page settle (AJAX, re-renders, animations) so the next snapshot
// reflects the result of the action rather than a half-rendered intermediate.
export const SETTLE_DELAY_MS = 400;

/** A navigation rebuilds the whole document — it needs longer than a click. */
export const NAV_SETTLE_DELAY_MS = 1500;

// Message types on the chrome.runtime bus.
export const MSG = {
  RUN_GOAL: 'RUN_GOAL',
  STOP: 'STOP',
  EXTRACT: 'EXTRACT',
  INSPECT: 'INSPECT',
  EXECUTE: 'EXECUTE',
  OVERLAY_SHOW: 'OVERLAY_SHOW',
  OVERLAY_OFF: 'OVERLAY_OFF',
  VAULT_LIST: 'VAULT_LIST',
  VAULT_CLEAR: 'VAULT_CLEAR',
  // The persistent tier. Popup <-> service worker only, so unlike the others
  // these are not mirrored into src/content/.
  VAULT_STATUS: 'VAULT_STATUS',
  VAULT_SET_PASS: 'VAULT_SET_PASS',
  VAULT_UNLOCK: 'VAULT_UNLOCK',
  VAULT_LOCK: 'VAULT_LOCK',
  VAULT_REMEMBER: 'VAULT_REMEMBER',
  VAULT_RECALL: 'VAULT_RECALL',
  VAULT_FORGET: 'VAULT_FORGET',
  VAULT_FORGET_ALL: 'VAULT_FORGET_ALL',
  HISTORY_CLEAR: 'HISTORY_CLEAR',
  TRACE: 'TRACE',
  STATUS: 'STATUS',
};
