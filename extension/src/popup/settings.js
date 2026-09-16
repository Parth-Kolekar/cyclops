/**
 * The settings page: screen graph, privacy and vault.
 *
 * These moved out of the popup because none of them fit in 390px — a 120-row
 * element list and a raw JSON payload need the width, and a full tab stays
 * open while you drive the page underneath it.
 *
 * The catch that shapes this file: opening in a tab makes THIS the active tab,
 * so "the current page" would resolve to the settings page itself. The popup
 * records which tab was in front when the gear was clicked, and every inspect
 * call names that tab explicitly.
 */

import { ENDPOINTS, MSG } from '../lib/config.js';

const $ = (id) => document.getElementById(id);

const $dot = $('server-dot');
const $sgSummary = $('sg-summary');
const $sgList = $('sg-list');
const $sgCount = $('sg-count');
const $sgFilter = $('sg-filter');
const $inspect = $('inspect');
const $clearOverlay = $('clear-overlay');
const $audit = $('audit');
const $clearVault = $('clear-vault');
const $pvStats = $('pv-stats');
const $pvList = $('pv-list');
const $pvVault = $('pv-vault');
const $pvCount = $('pv-count');
const $pvJson = $('pv-json');

let graph = null;
/** The page we are inspecting — never this tab. */
let target = null;

// ------------------------------------------------------------------ tabs

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.panel').forEach((p) => {
      p.classList.toggle('hidden', p.id !== `panel-${tab.dataset.tab}`);
    });
  });
});

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

// --------------------------------------------------------- privacy panel

function renderPrivacy({ graph: g, payload, findings, stats }) {
  const kinds = [...new Set(findings.map((f) => f.kind))];
  const row = (k, v) => `<div class="s"><span>${k}</span><span>${v}</span></div>`;

  $pvStats.innerHTML =
    row('PII found', `<b>${findings.length}</b>`) +
    row('tokenised', `<b>${findings.length}</b>`) +
    row('leaked', '<b>0</b>') +
    row('kinds', kinds.length) +
    row('detect time', `${g?.pii?.scan_ms ?? '—'} ms`) +
    row('method', 'opaque fill') +
    (stats
      ? row('payloads sent', stats.payloads) + row('fills refused', stats.fills_refused)
      : '');
  $pvStats.classList.remove('hidden');

  // Left: what is on the screen. Right: what the server receives instead.
  $pvCount.textContent = findings.length ? `${findings.length} replaced` : 'nothing found';
  $pvList.innerHTML = '';

  if (!findings.length) {
    $pvList.innerHTML = '<li class="empty">No personal data detected on this page.</li>';
  } else {
    for (const f of findings) {
      const li = document.createElement('li');
      li.innerHTML = `
        <span class="kind"></span><span class="where"></span>
        <div class="pair">
          <span class="before"></span>
          <span class="arrow">→</span>
          <span class="after"></span>
        </div>
        <div class="meta"></div>`;
      li.querySelector('.kind').textContent = f.kind;
      li.querySelector('.where').textContent = `${f.element_id} · ${f.where}`;
      li.querySelector('.before').textContent = f.value;
      li.querySelector('.after').textContent = f.token || '—';
      li.querySelector('.meta').textContent =
        `${f.detector} · confidence ${(f.confidence * 100) | 0}%`;
      $pvList.appendChild(li);
    }
  }

  const payloadCopy = { ...payload };
  const $container = $('pv-screenshot-container');
  if (payload?.image_base64) {
    $('pv-screenshot').src = payload.image_base64;
    $container.classList.remove('hidden');
    payloadCopy.image_base64 = '[REDACTED_IMAGE_DATA_HIDDEN_FROM_UI]';
  } else {
    $container.classList.add('hidden');
  }

  $pvJson.textContent = JSON.stringify(payloadCopy, null, 1);
}

async function renderVault() {
  const res = await chrome.runtime.sendMessage({ type: MSG.VAULT_LIST });
  $pvVault.innerHTML = '';
  if (!res?.ok || !res.entries.length) {
    $pvVault.innerHTML = '<li class="empty">Vault is empty.</li>';
    return;
  }
  for (const e of res.entries) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="tok"></span><span class="msk"></span><span class="len"></span>`;
    li.querySelector('.tok').textContent = e.token;
    li.querySelector('.msk').textContent = e.masked;
    li.querySelector('.len').textContent = `${e.length} chars`;
    $pvVault.appendChild(li);
  }
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

$inspect.addEventListener('click', async () => {
  $inspect.disabled = true;
  $inspect.textContent = 'Scanning…';
  try {
    const res = await chrome.runtime.sendMessage({
      type: MSG.INSPECT,
      mode: 'graph',
      tabId: target?.id,
    });
    if (res?.ok) showGraph(res.graph);
    else fail(res?.error || 'no reply from the service worker — reload the extension');
  } catch (err) {
    fail(String(err.message || err));
  } finally {
    $inspect.disabled = false;
    $inspect.textContent = 'Scan page';
  }
});

$audit.addEventListener('click', async () => {
  $audit.disabled = true;
  $audit.textContent = 'Redacting…';
  try {
    const res = await chrome.runtime.sendMessage({
      type: MSG.INSPECT,
      mode: 'redact',
      tabId: target?.id,
    });
    if (!res?.ok) {
      $pvList.innerHTML = '<li class="empty err"></li>';
      $pvList.firstChild.textContent =
        res?.error || 'no reply from the service worker — reload the extension';
      return;
    }
    graph = res.graph;
    renderPrivacy({
      graph: res.graph,
      payload: res.payload,
      findings: res.graph.pii?.findings ?? [],
      stats: res.stats,
    });
    await renderVault();
  } finally {
    $audit.disabled = false;
    $audit.textContent = 'Show what leaves';
  }
});

$clearVault.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: MSG.VAULT_CLEAR });
  await renderVault();
});

$clearOverlay.addEventListener('click', async () => {
  if (!target?.id) return;
  chrome.tabs.sendMessage(target.id, { type: MSG.OVERLAY_OFF }).catch(() => {});
});

$sgFilter.addEventListener('input', () => {
  if (graph) renderElements(graph, $sgFilter.value);
});

// ------------------------------------------------------------ vault panel

const $vtStatus = $('vt-status');
const $vtSetup = $('vt-setup');
const $vtLocked = $('vt-locked');
const $vtOpen = $('vt-open');
const $vtList = $('vt-list');
const $vtCount = $('vt-count');
const $vtError = $('vt-error');

async function vaultOp(type, extra = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...extra });
  $vtError.textContent = res?.ok
    ? ''
    : res?.error || 'no reply from the service worker — reload the extension';
  return res?.ok ? res : null;
}

function renderPersistent(res) {
  if (!res) return;
  const { status, entries = [] } = res;

  // Exactly one of the three forms is on screen at a time, driven entirely by
  // the status the worker just reported rather than by local guesswork.
  $vtSetup.classList.toggle('hidden', status.configured);
  $vtLocked.classList.toggle('hidden', !status.configured || status.unlocked);
  $vtOpen.classList.toggle('hidden', !status.unlocked);

  const row = (k, v) => `<div class="s"><span>${k}</span><span>${v}</span></div>`;
  const state = !status.configured ? 'not set up' : status.unlocked ? 'unlocked' : 'locked';
  $vtStatus.innerHTML =
    row('state', `<b>${state}</b>`) +
    row('remembered', status.count) +
    row('at rest', 'AES-256-GCM') +
    row('key', `PBKDF2 · ${status.iterations.toLocaleString()} rounds`) +
    `<div class="s wide"><span>key location</span><span>memory only — never on disk</span></div>`;

  $vtCount.textContent = entries.length ? String(entries.length) : '';
  $vtList.innerHTML = '';
  if (!entries.length) {
    $vtList.innerHTML = '<li class="empty">Nothing remembered yet.</li>';
    return;
  }

  for (const e of entries) {
    const li = document.createElement('li');
    // Skeleton via innerHTML, every value via textContent — the masked value
    // ultimately comes from something the user typed.
    li.innerHTML = '<span class="kind"></span><span class="msk"></span><button class="forget"></button>';
    li.querySelector('.kind').textContent = e.kind;
    li.querySelector('.msk').textContent = e.locked ? '••••••••' : e.masked;
    const del = li.querySelector('.forget');
    del.textContent = 'forget';
    del.addEventListener('click', async () => {
      renderPersistent(await vaultOp(MSG.VAULT_FORGET, { id: e.id }));
    });
    $vtList.appendChild(li);
  }
}

$('vt-create').addEventListener('click', async () => {
  const pass = $('vt-new-pass').value;
  if (pass !== $('vt-new-pass2').value) {
    $vtError.textContent = 'the two passphrases do not match';
    return;
  }
  const res = await vaultOp(MSG.VAULT_SET_PASS, { passphrase: pass });
  if (res) {
    $('vt-new-pass').value = '';
    $('vt-new-pass2').value = '';
    renderPersistent(res);
  }
});

$('vt-unlock').addEventListener('click', async () => {
  const res = await vaultOp(MSG.VAULT_UNLOCK, { passphrase: $('vt-pass').value });
  if (res) {
    $('vt-pass').value = '';
    renderPersistent(res);
  }
});

$('vt-pass').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('vt-unlock').click();
});

$('vt-lock').addEventListener('click', async () => {
  renderPersistent(await vaultOp(MSG.VAULT_LOCK));
});

$('vt-remember').addEventListener('click', async () => {
  const value = $('vt-value').value.trim();
  if (!value) {
    $vtError.textContent = 'nothing to remember';
    return;
  }
  const res = await vaultOp(MSG.VAULT_REMEMBER, { kind: $('vt-kind').value, value });
  if (res) {
    $('vt-value').value = '';
    renderPersistent(res);
  }
});

$('vt-value').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('vt-remember').click();
});

$('vt-destroy').addEventListener('click', async () => {
  renderPersistent(await vaultOp(MSG.VAULT_FORGET_ALL));
});

// ------------------------------------------------------------------ init

/** Say which page these buttons act on, so it is never a guess. */
function showTarget() {
  const label = document.createElement('p');
  label.className = 'target';
  if (target) {
    label.textContent = `Acting on: ${target.title || target.url}`;
  } else {
    label.className = 'target warn';
    label.textContent =
      'No page recorded — open settings from the Cyclops popup while the page you want is in front.';
  }
  document.querySelector('.tabs').after(label);
}

(async () => {
  const stored = await chrome.storage.session.get([
    'settingsTarget', 'lastGraph', 'lastPayload', 'lastFindings', 'stats',
  ]);
  target = stored.settingsTarget || null;
  showTarget();

  if (stored.lastGraph) showGraph(stored.lastGraph);
  else $sgList.innerHTML = '<li class="empty">Hit “Scan page”.</li>';

  if (stored.lastPayload) {
    renderPrivacy({
      graph: stored.lastGraph,
      payload: stored.lastPayload,
      findings: stored.lastFindings || [],
      stats: stored.stats,
    });
  } else {
    $pvList.innerHTML = '<li class="empty">Hit “Show what leaves”.</li>';
  }

  await renderVault();
  renderPersistent(await vaultOp(MSG.VAULT_RECALL));
  checkServer();
})();
