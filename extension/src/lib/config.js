// Single source of truth for constants shared across the extension.
// Phase 0: kept deliberately tiny. Grows as the pipeline grows.

export const SERVER_BASE = 'http://localhost:8000';

export const ENDPOINTS = {
  plan: `${SERVER_BASE}/v1/plan`,
  health: `${SERVER_BASE}/v1/health`,
};

// Safety rail: never let the agent loop forever during a demo.
export const MAX_STEPS = 8;

// Message types on the chrome.runtime bus.
export const MSG = {
  RUN_GOAL: 'RUN_GOAL',
  STOP: 'STOP',
  EXTRACT: 'EXTRACT',
  EXECUTE: 'EXECUTE',
  TRACE: 'TRACE',
  STATUS: 'STATUS',
};
