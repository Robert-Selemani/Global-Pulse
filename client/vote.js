/* global GP */
'use strict';

/**
 * Voting page. Requires a logged-in account. Participants add / edit / withdraw
 * their own communities in a specific poll, chosen with ?poll=<slug> (from the
 * organizer's join link or QR). Poll management (code, QR, export) lives on the
 * organizer dashboard, not here.
 */

const params = new URLSearchParams(location.search);
const POLL_SLUG = params.get('poll') || 'global-pulse';
const urlCode = params.get('code');
const API = '/api/poll/' + encodeURIComponent(POLL_SLUG);

const state = {
  participationRequired: false,
  editingId: null,
  archived: false,
};

const $ = (id) => document.getElementById(id);
const el = {
  pollTitle: $('poll-title'),
  accountEmail: $('account-email'),
  logoutBtn: $('logout-btn'),
  form: $('entry-form'),
  formTitle: $('form-title'),
  communityInput: $('community-input'),
  submitBtn: $('submit-btn'),
  cancelEditBtn: $('cancel-edit-btn'),
  formMessage: $('form-message'),
  codeField: $('code-field'),
  participationInput: $('participation-input'),
  minePanel: $('mine-panel'),
  mineList: $('mine-list'),
};

function setMessage(text, kind) {
  el.formMessage.textContent = text;
  el.formMessage.className = 'form-message' + (kind ? ' ' + kind : '');
}

// ---------------------------------------------------------------------------
// Participation code (participant side)
// ---------------------------------------------------------------------------
function codeStorageKey() {
  return 'gp_code_' + POLL_SLUG;
}
function rememberCode(code) {
  try {
    if (code) localStorage.setItem(codeStorageKey(), code);
  } catch (_) {
    /* ignore */
  }
}
function revealCodeField() {
  el.codeField.hidden = false;
  el.participationInput.focus();
}
function applyParticipationConfig(required, codeProvided) {
  state.participationRequired = required;
  const haveCode = codeProvided || !!el.participationInput.value.trim();
  el.codeField.hidden = !required || haveCode;
}

// ---------------------------------------------------------------------------
// Entry form (create / edit)
// ---------------------------------------------------------------------------
el.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.archived) return setMessage('This poll is archived and read-only.', 'error');
  const countryId = GP.els.countrySelect.value;
  const opt = GP.els.countrySelect.selectedOptions[0];
  const countryName = opt ? opt.dataset.name : '';
  const community = el.communityInput.value.trim();

  if (!countryId) return setMessage('Please choose a country.', 'error');
  if (!community) return setMessage('Please enter a community name.', 'error');

  const code = el.participationInput.value.trim();
  if (state.participationRequired && !code) {
    revealCodeField();
    return setMessage('Enter the participation code to continue.', 'error');
  }
  rememberCode(code);

  const editing = state.editingId;
  el.submitBtn.disabled = true;
  setMessage(editing ? 'Updating…' : 'Adding…', '');

  const endpoint = editing ? API + '/submission/' + editing : API + '/submit';
  const method = editing ? 'PUT' : 'POST';

  try {
    const res = await fetch(endpoint, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ countryId, countryName, community, code }),
    });
    const payload = await res.json();
    if (!res.ok) {
      if (payload.code === 'BAD_CODE') revealCodeField();
      if (res.status === 401) {
        location.href = '/login?next=' + encodeURIComponent('/vote?poll=' + POLL_SLUG);
        return;
      }
      throw new Error(payload.error || 'Submission failed');
    }
    GP.applyData(payload.data);
    GP.selectCountry(countryId);
    el.communityInput.value = '';
    await refreshMine();
    if (editing) {
      exitEditMode();
      setMessage('Submission updated ✅', 'success');
    } else {
      setMessage('Added to ' + countryName + '! ✅', 'success');
    }
  } catch (err) {
    setMessage(err.message, 'error');
  } finally {
    el.submitBtn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// My submissions (edit / withdraw)
// ---------------------------------------------------------------------------
async function refreshMine() {
  try {
    const { submissions } = await fetch(API + '/mine').then((r) => r.json());
    renderMine(submissions || []);
  } catch (_) {
    /* ignore */
  }
}

function renderMine(subs) {
  el.mineList.innerHTML = '';
  el.minePanel.hidden = subs.length === 0;
  if (!subs.length) return;
  const frag = document.createDocumentFragment();
  for (const s of subs) {
    const li = document.createElement('li');
    li.className = 'mine-row';

    const label = document.createElement('span');
    label.className = 'mine-label';
    const iso2 = GP.state.flags[s.countryId];
    if (iso2) {
      const flag = document.createElement('img');
      flag.className = 'row-flag';
      flag.src = GP.FLAG_BASE + '/24x18/' + iso2 + '.png';
      flag.alt = '';
      label.appendChild(flag);
    }
    label.appendChild(document.createTextNode(s.community + ' · ' + s.countryName));

    const actions = document.createElement('span');
    actions.className = 'mine-actions';
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'mini-btn';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => startEdit(s));
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'mini-btn danger';
    delBtn.textContent = 'Withdraw';
    delBtn.addEventListener('click', () => withdraw(s));
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);

    li.appendChild(label);
    li.appendChild(actions);
    frag.appendChild(li);
  }
  el.mineList.appendChild(frag);
}

function startEdit(sub) {
  state.editingId = sub.id;
  GP.els.countrySelect.value = sub.countryId;
  el.communityInput.value = sub.community;
  el.formTitle.textContent = 'Edit your submission';
  el.submitBtn.textContent = 'Update';
  el.cancelEditBtn.hidden = false;
  GP.selectCountry(sub.countryId);
  el.communityInput.focus();
  setMessage('Editing your submission…', '');
}

function exitEditMode() {
  state.editingId = null;
  el.formTitle.textContent = 'Add your community';
  el.submitBtn.textContent = 'Add to the map';
  el.cancelEditBtn.hidden = true;
  el.communityInput.value = '';
}

el.cancelEditBtn.addEventListener('click', () => {
  exitEditMode();
  setMessage('', '');
});

async function withdraw(sub) {
  if (!window.confirm('Withdraw your submission "' + sub.community + '"?')) return;
  try {
    const res = await fetch(API + '/submission/' + sub.id, { method: 'DELETE' });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || 'Could not withdraw');
    if (state.editingId === sub.id) exitEditMode();
    GP.applyData(payload.data);
    await refreshMine();
    setMessage('Submission withdrawn.', 'success');
  } catch (err) {
    setMessage(err.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------
el.logoutBtn.addEventListener('click', async () => {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch (_) {
    /* ignore */
  }
  location.href = '/present';
});

function lockArchived() {
  state.archived = true;
  el.submitBtn.disabled = true;
  el.communityInput.disabled = true;
  GP.els.countrySelect.disabled = true;
  setMessage('This poll has been archived — it is now read-only.', 'error');
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async function boot() {
  // Gate: must be logged in.
  let session;
  try {
    session = await fetch('/api/session').then((r) => r.json());
  } catch (_) {
    session = { authenticated: false };
  }
  if (!session.authenticated) {
    const next = '/vote?poll=' + POLL_SLUG + (urlCode ? '&code=' + encodeURIComponent(urlCode) : '');
    location.href = '/login?next=' + encodeURIComponent(next);
    return;
  }

  // Resolve the poll first so a bad slug fails clearly.
  let cfg = null;
  try {
    const res = await fetch(API + '/config');
    if (!res.ok) throw new Error('Poll not found');
    cfg = await res.json();
  } catch (_) {
    setMessage('That poll could not be found. Check your join link.', 'error');
    return;
  }
  if (el.pollTitle) el.pollTitle.textContent = cfg.title || 'Global Pulse';
  document.title = 'Vote — ' + (cfg.title || 'Global Pulse');

  GP.setDataUrl(API + '/data');
  GP.initMap();
  try {
    await GP.boot();
  } catch (err) {
    setMessage('Could not load the map: ' + err.message, 'error');
    return;
  }

  if (el.accountEmail) el.accountEmail.textContent = session.email;

  // Seed participation code from the URL (scanned QR) or a previous session.
  let savedCode = urlCode || '';
  try {
    savedCode = urlCode || localStorage.getItem(codeStorageKey()) || '';
  } catch (_) {
    /* ignore */
  }
  if (savedCode) {
    el.participationInput.value = savedCode.trim();
    rememberCode(savedCode.trim());
  }
  applyParticipationConfig(!!cfg.participationRequired, !!savedCode.trim());

  if (cfg.status === 'archived') {
    lockArchived();
  } else {
    await refreshMine();
    GP.startPolling();
  }
})();
