import { ENDPOINTS, MSG } from '../lib/config.js';

const $goal = document.getElementById('goal');
const $run = document.getElementById('run');
const $stop = document.getElementById('stop');
const $log = document.getElementById('log');
const $state = document.getElementById('state');
const $dot = document.getElementById('server-dot');

const LAST_GOAL_KEY = 'cyclops.lastGoal';

function addEntry({ kind, text, ms }) {
  const li = document.createElement('li');
  li.className = kind;
  li.innerHTML = `
    <span class="k">${kind}</span>
    <span class="t"></span>
    <span class="ms">${ms != null ? `${ms} ms` : ''}</span>`;
  li.querySelector('.t').textContent = text;
  $log.appendChild(li);
  $log.scrollTop = $log.scrollHeight;
}

function setState(state) {
  $state.textContent = state;
  const busy = state !== 'idle';
  $run.disabled = busy;
}

// The popup is a fresh page each time it opens, so the trace lives in
// session storage and is replayed on open.
async function loadTrace() {
  const { trace = [] } = await chrome.storage.session.get('trace');
  $log.innerHTML = '';
  if (!trace.length) {
    $log.innerHTML = '<li class="empty"><span class="t">No steps yet.</span></li>';
    return;
  }
  trace.forEach(addEntry);
}

async function pushTrace(entry) {
  const { trace = [] } = await chrome.storage.session.get('trace');
  trace.push(entry);
  await chrome.storage.session.set({ trace: trace.slice(-50) });
}

async function checkServer() {
  try {
    const r = await fetch(ENDPOINTS.health);
    $dot.className = r.ok ? 'dot up' : 'dot down';
    $dot.title = r.ok ? 'server up' : `server ${r.status}`;
  } catch {
    $dot.className = 'dot down';
    $dot.title = 'server unreachable — is uvicorn running?';
  }
}

$run.addEventListener('click', async () => {
  const goal = $goal.value.trim();
  if (!goal) return;
  await chrome.storage.session.set({ trace: [], [LAST_GOAL_KEY]: goal });
  $log.innerHTML = '';
  setState('starting');
  chrome.runtime.sendMessage({ type: MSG.RUN_GOAL, goal });
});

$stop.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: MSG.STOP });
  setState('idle');
});

$goal.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $run.click();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === MSG.TRACE) {
    if ($log.querySelector('.empty')) $log.innerHTML = '';
    addEntry(msg.entry);
    pushTrace(msg.entry);
  } else if (msg.type === MSG.STATUS) {
    setState(msg.state);
  }
});

(async () => {
  const stored = await chrome.storage.session.get(LAST_GOAL_KEY);
  $goal.value = stored[LAST_GOAL_KEY] || 'Fill this form and submit it';
  await loadTrace();
  checkServer();
})();
