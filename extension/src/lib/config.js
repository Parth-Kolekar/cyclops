// Single source of truth for constants shared across the extension.
// Phase 0: kept deliberately tiny. Grows as the pipeline grows.

export const SERVER_BASE = 'http://localhost:8000';

export const ENDPOINTS = {
  plan: `${SERVER_BASE}/v1/plan`,
  verify: `${SERVER_BASE}/v1/verify`,
  health: `${SERVER_BASE}/v1/health`,
  metrics: `${SERVER_BASE}/v1/metrics`,
};

// Safety rail: never let the agent loop forever during a demo.
export const MAX_STEPS = 8;

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
  TRACE: 'TRACE',
  STATUS: 'STATUS',
};
