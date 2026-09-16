/**
 * The chat popup.
 *
 * One stream holds three kinds of row: what the user asked, what the agent
 * said back, and the individual steps it took in between. The step rows are
 * deliberately in the conversation rather than behind a toggle — "7 PII
 * tokenised · 0 leaked" scrolling past mid-task is the whole claim, and it
 * stops being persuasive if you have to go looking for it.
 *
 * Screen graph, privacy and vault moved to settings.html, which opens in a
 * full tab where a 120-row element list and a raw payload actually fit.
 */

import { ENDPOINTS, MSG } from '../lib/config.js';

const $ = (id) => document.getElementById(id);

const $thread = $('thread');
const $goal = $('goal');
const $run = $('run');
const $stop = $('stop');
const $state = $('state');
const $dot = $('server-dot');

const LAST_GOAL_KEY = 'cyclops.lastGoal';

/** Trace kinds that read as the agent talking rather than as machinery. */
const SPEECH_KINDS = new Set(['done', 'ask', 'say']);

// ------------------------------------------------------------------ render

function atBottom() {
  return $thread.scrollHeight - $thread.scrollTop - $thread.clientHeight < 40;
}

function scroll(wasAtBottom) {
  if (wasAtBottom) $thread.scrollTop = $thread.scrollHeight;
}

function clearPlaceholder() {
  const empty = $thread.querySelector('.empty');
  if (empty) empty.remove();
}

/** A chat bubble. `who` is 'user' or 'agent'. */
function addBubble(who, text) {
  const stick = atBottom();
  clearPlaceholder();
  const div = document.createElement('div');
  div.className = `msg ${who}`;
  const body = document.createElement('div');
  body.className = 'bubble';
  body.textContent = text;
  div.appendChild(body);
  $thread.appendChild(div);
  scroll(stick);
  return div;
}

/** A compact machinery row: what the agent did, and how long it took. */
function addStep({ kind, text, ms }) {
  const stick = atBottom();
  clearPlaceholder();
  const row = document.createElement('div');
  row.className = `step ${kind}`;
  const k = document.createElement('span');
  k.className = 'k';
  k.textContent = kind;
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = text;
  const m = document.createElement('span');
  m.className = 'ms';
  m.textContent = ms != null ? `${ms} ms` : '';
  row.append(k, t, m);
  $thread.appendChild(row);
  scroll(stick);
  return row;
}

/** Route one trace entry to whichever row type it reads as. */
function addEntry(entry) {
  if (SPEECH_KINDS.has(entry.kind)) return addBubble('agent', entry.text);
  return addStep(entry);
}

function setState(state) {
  $state.textContent = state || 'idle';
  const busy = !!state && state !== 'idle';
  $run.disabled = busy;
  $stop.disabled = !busy;
}

// The popup is a fresh page every time it opens, so the conversation lives in
// session storage and is replayed here.
async function loadThread() {
  const { thread = [] } = await chrome.storage.session.get('thread');
  $thread.innerHTML = '';
  if (!thread.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Tell Cyclops what to do on this page.';
    $thread.appendChild(p);
    return;
  }
  for (const row of thread) {
    if (row.role) addBubble(row.role, row.text);
    else addEntry(row);
  }
  $thread.scrollTop = $thread.scrollHeight;
}

async function remember(row) {
  const { thread = [] } = await chrome.storage.session.get('thread');
  thread.push(row);
  await chrome.storage.session.set({ thread: thread.slice(-120) });
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

async function send() {
  const goal = $goal.value.trim();
  if (!goal) return;

  addBubble('user', goal);
  await remember({ role: 'user', text: goal });
  await chrome.storage.session.set({ [LAST_GOAL_KEY]: goal });
  $goal.value = '';
  setState('starting');

  try {
    const res = await chrome.runtime.sendMessage({ type: MSG.RUN_GOAL, goal });
    if (!res?.ok) {
      const text = res?.error || 'no reply from the service worker — reload the extension';
      addStep({ kind: 'error', text });
      await remember({ kind: 'error', text });
      setState('idle');
    }
  } catch (err) {
    const text = String(err.message || err);
    addStep({ kind: 'error', text });
    await remember({ kind: 'error', text });
    setState('idle');
  }
}

$run.addEventListener('click', send);

$stop.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: MSG.STOP });
  setState('idle');
});

// Enter sends; Shift+Enter is a newline, the convention everywhere else.
$goal.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

$('gear').addEventListener('click', async () => {
  // Settings opens in its own tab, which then becomes the active one. Record
  // the page the user was actually looking at so "Scan page" over there still
  // means this page, not the settings page.
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) {
    await chrome.storage.session.set({
      settingsTarget: { id: tab.id, title: tab.title || '', url: tab.url || '' },
    });
  }
  chrome.tabs.create({ url: chrome.runtime.getURL('src/popup/settings.html') });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === MSG.TRACE) {
    addEntry(msg.entry);
    remember(msg.entry);
  } else if (msg.type === MSG.STATUS) {
    setState(msg.state);
  }
});

// ------------------------------------------------------------------ init

(async () => {
  const stored = await chrome.storage.session.get(LAST_GOAL_KEY);
  $goal.placeholder = stored[LAST_GOAL_KEY]
    ? `Last: ${stored[LAST_GOAL_KEY]}`
    : 'What should I do on this page?';
  await loadThread();
  setState('idle');
  checkServer();
})();
