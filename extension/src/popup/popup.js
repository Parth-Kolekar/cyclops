import { ENDPOINTS, MSG } from '../lib/config.js';

const $ = (id) => document.getElementById(id);

const $goal = $('goal');
const $run = $('run');
const $stop = $('stop');
const $log = $('log');
const $state = $('state');
const $dot = $('server-dot');
const $inspect = $('inspect');
const $clearOverlay = $('clear-overlay');
const $sgSummary = $('sg-summary');
const $sgList = $('sg-list');
const $sgCount = $('sg-count');
const $sgFilter = $('sg-filter');

const LAST_GOAL_KEY = 'cyclops.lastGoal';

let graph = null;

// ------------------------------------------------------------------ tabs

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.panel').forEach((p) => {
      p.classList.toggle('hidden', p.id !== `panel-${tab.dataset.tab}`);
    });
  });
});

// ------------------------------------------------------------ step trace

function addEntry({ kind, text, ms }) {
  const li = document.createElement('li');
  li.className = kind;
  li.innerHTML = `<span class="k"></span><span class="t"></span><span class="ms"></span>`;
  li.querySelector('.k').textContent = kind;
  li.querySelector('.t').textContent = text;
  li.querySelector('.ms').textContent = ms != null ? `${ms} ms` : '';
  $log.appendChild(li);
  $log.scrollTop = $log.scrollHeight;
}

function setState(state) {
  $state.textContent = state || 'idle';
  $run.disabled = !!state && state !== 'idle';
}

// The popup is a fresh page every time it opens, so the trace and the last
// scan live in session storage and are replayed here.
async function loadTrace() {
  const { trace = [] } = await chrome.storage.session.get('trace');
  $log.innerHTML = '';
  if (!trace.length) {
    $log.innerHTML = '<li class="empty">No steps yet.</li>';
    return;
  }
  trace.forEach(addEntry);
}

async function pushTrace(entry) {
  const { trace = [] } = await chrome.storage.session.get('trace');
  trace.push(entry);
  await chrome.storage.session.set({ trace: trace.slice(-50) });
}

// ----------------------------------------------------------- screen graph

function renderSummary(g) {
  const roles = g.elements.reduce((acc, e) => {
    acc[e.role] = (acc[e.role] || 0) + 1;
    return acc;
  }, {});
  const actionable = ['button', 'textbox', 'select', 'checkbox', 'radio', 'link']
    .reduce((n, r) => n + (roles[r] || 0), 0);

  const row = (k, v) => `<div class="s"><span>${k}</span><span>${v}</span></div>`;

  $sgSummary.innerHTML =
    row('page kind', `<b>${g.page.kind}</b> ${(g.page.kind_confidence * 100) | 0}%`) +
    row('elements', g.elements.length) +
    row('actionable', actionable) +
    row('text nodes', roles.text || 0) +
    row('opaque regions', g.opaque_regions.length) +
    row('merged nested', g.stats.merged_by_dedupe) +
    row('extract time', `${g.stats.extract_ms} ms`) +
    row('coord space', `${g.viewport.norm_width}px`) +
    (g.stats.dropped_by_cap
      ? `<div class="s wide"><span>dropped by 120 cap</span><span>${g.stats.dropped_by_cap}</span></div>`
      : '');
  $sgSummary.classList.remove('hidden');
}

function renderElements(g, filter = '') {
  const q = filter.trim().toLowerCase();
  const rows = g.elements.filter(
    (e) => !q || e.label.toLowerCase().includes(q) || e.role.includes(q) || e.id === q
  );

  $sgCount.textContent = q ? `${rows.length} / ${g.elements.length}` : `${g.elements.length}`;
  $sgList.innerHTML = '';

  if (!rows.length) {
    $sgList.innerHTML = '<li class="empty">Nothing matches.</li>';
    return;
  }

  for (const e of rows) {
    const li = document.createElement('li');
    li.className = e.role;
    li.title = `${e.role} · bbox ${e.bbox.join(', ')}`;
    li.innerHTML = `<span class="id"></span><span class="role"></span>
                    <span class="lbl"></span><span class="val"></span>`;
    li.querySelector('.id').textContent = e.id;
    li.querySelector('.role').textContent = e.role;
    li.querySelector('.lbl').textContent = e.label || e.text || '—';
    li.querySelector('.val').textContent = e.value ? `= ${e.value}` : '';
    $sgList.appendChild(li);
  }
}

function fail(message) {
  $sgSummary.classList.add('hidden');
  $sgList.innerHTML = '<li class="empty err"></li>';
  $sgList.firstChild.textContent = message;
  $sgCount.textContent = '';
}

function showGraph(g) {
  graph = g;
  renderSummary(g);
  renderElements(g, $sgFilter.value);
}

// ---------------------------------------------------------------- server

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

// ---------------------------------------------------------------- events

$run.addEventListener('click', async () => {
  const goal = $goal.value.trim();
  if (!goal) return;
  await chrome.storage.session.set({ trace: [], [LAST_GOAL_KEY]: goal });
  $log.innerHTML = '';
  setState('starting');
  try {
    const res = await chrome.runtime.sendMessage({ type: MSG.RUN_GOAL, goal });
    if (!res?.ok) {
      addEntry({ kind: 'error', text: res?.error || 'no reply from the service worker — reload the extension' });
      setState('idle');
    }
  } catch (err) {
    addEntry({ kind: 'error', text: String(err.message || err) });
    setState('idle');
  }
});

$stop.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: MSG.STOP });
  setState('idle');
});

$goal.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $run.click();
});

$inspect.addEventListener('click', async () => {
  $inspect.disabled = true;
  $inspect.textContent = 'Scanning…';
  try {
    const res = await chrome.runtime.sendMessage({ type: MSG.INSPECT, show: true });
    if (res?.ok) showGraph(res.graph);
    else fail(res?.error || 'no reply from the service worker — reload the extension');
  } catch (err) {
    fail(String(err.message || err));
  } finally {
    $inspect.disabled = false;
    $inspect.textContent = 'Scan page';
  }
});

$clearOverlay.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) chrome.tabs.sendMessage(tab.id, { type: 'OVERLAY_OFF' }).catch(() => {});
});

$sgFilter.addEventListener('input', () => {
  if (graph) renderElements(graph, $sgFilter.value);
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

// ------------------------------------------------------------------ init

(async () => {
  const stored = await chrome.storage.session.get([LAST_GOAL_KEY, 'lastGraph']);
  $goal.value = stored[LAST_GOAL_KEY] || 'Fill this form and submit it';
  if (stored.lastGraph) showGraph(stored.lastGraph);
  else $sgList.innerHTML = '<li class="empty">Hit “Scan page”.</li>';
  await loadTrace();
  checkServer();
})();
