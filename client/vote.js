/* global GP, qrcode */
'use strict';

/**
 * Voting page. Requires a logged-in account. End users add / edit / withdraw
 * their own communities; super admins additionally get the continent focus and
 * the participation-code + QR panel.
 */

const state = {
  participationRequired: false,
  editingId: null,
  isSuperAdmin: false,
};

const $ = (id) => document.getElementById(id);
const el = {
  accountEmail: $('account-email'),
  accountRole: $('account-role'),
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
  codePanel: $('code-panel'),
  codeStatus: $('code-status'),
  codeValue: $('code-value'),
  qrBox: $('qr-box'),
  codeGenerate: $('code-generate'),
  codeDisable: $('code-disable'),
};

const urlCode = new URLSearchParams(location.search).get('code');

function setMessage(text, kind) {
  el.formMessage.textContent = text;
  el.formMessage.className = 'form-message' + (kind ? ' ' + kind : '');
}

// ---------------------------------------------------------------------------
// Participation code (participant side)
// ---------------------------------------------------------------------------
function rememberCode(code) {
  try {
    if (code) localStorage.setItem('gp_code', code);
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
  // Only ask for a code when one is required AND we don't already have it —
  // whether from a scanned QR / shared link (?code=) or a remembered code.
  // This prevents asking a participant to both use the link and type the code.
  const haveCode = codeProvided || !!el.participationInput.value.trim();
  el.codeField.hidden = !required || haveCode;
}

// ---------------------------------------------------------------------------
// Entry form (create / edit)
// ---------------------------------------------------------------------------
el.form.addEventListener('submit', async (e) => {
  e.preventDefault();
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

  const endpoint = editing ? '/api/submission/' + editing : '/api/submit';
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
        location.href = '/login?next=/vote';
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
    const { submissions } = await fetch('/api/mine').then((r) => r.json());
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
    const res = await fetch('/api/submission/' + sub.id, { method: 'DELETE' });
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
// Super admin: participation code + QR
// ---------------------------------------------------------------------------
function renderQr(container, text) {
  container.innerHTML = '';
  try {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    container.innerHTML = qr.createImgTag(5, 8);
    const img = container.querySelector('img');
    if (img) img.alt = 'QR code to join';
  } catch (_) {
    container.textContent = text;
  }
}
function joinUrl(code) {
  return location.origin + '/vote?code=' + encodeURIComponent(code);
}
function renderAdminCode(code) {
  if (code) {
    el.codeStatus.textContent = 'Attendees enter this code (or scan the QR) to participate:';
    el.codeValue.textContent = code;
    el.codeValue.hidden = false;
    el.qrBox.hidden = false;
    renderQr(el.qrBox, joinUrl(code));
    el.codeDisable.hidden = false;
    el.codeGenerate.textContent = 'Regenerate code';
  } else {
    el.codeStatus.textContent = 'No code set — participation is open to everyone.';
    el.codeValue.hidden = true;
    el.qrBox.hidden = true;
    el.qrBox.innerHTML = '';
    el.codeDisable.hidden = true;
    el.codeGenerate.textContent = 'Generate code';
  }
}
async function loadAdminCode() {
  try {
    const res = await fetch('/api/admin/code');
    if (!res.ok) return;
    const { code } = await res.json();
    renderAdminCode(code);
  } catch (_) {
    /* ignore */
  }
}
el.codeGenerate.addEventListener('click', async () => {
  el.codeGenerate.disabled = true;
  try {
    const { code } = await fetch('/api/admin/code', { method: 'POST' }).then((r) => r.json());
    renderAdminCode(code);
    // The admin is a participant too — pre-fill the code so they aren't asked.
    el.participationInput.value = code;
    rememberCode(code);
    applyParticipationConfig(true, true);
  } catch (_) {
    /* ignore */
  } finally {
    el.codeGenerate.disabled = false;
  }
});
el.codeDisable.addEventListener('click', async () => {
  if (!window.confirm('Disable the participation code? Anyone signed in can participate.')) return;
  try {
    await fetch('/api/admin/code', { method: 'DELETE' });
    renderAdminCode(null);
    applyParticipationConfig(false);
  } catch (_) {
    /* ignore */
  }
});

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

function setupAccount(session) {
  el.accountEmail.textContent = session.email;
  state.isSuperAdmin = !!session.isSuperAdmin;
  if (state.isSuperAdmin) {
    el.accountRole.hidden = false;
    el.codePanel.hidden = false;
    if (GP.els.mapFocus) GP.els.mapFocus.hidden = false;
    loadAdminCode();
  }
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
    const next = '/vote' + (urlCode ? '?code=' + encodeURIComponent(urlCode) : '');
    location.href = '/login?next=' + encodeURIComponent(next);
    return;
  }

  GP.initMap();
  try {
    await GP.boot();
  } catch (err) {
    setMessage('Could not load the map: ' + err.message, 'error');
    return;
  }

  setupAccount(session);

  // Seed participation code from the URL (scanned QR) or a previous session.
  let savedCode = urlCode || '';
  try {
    savedCode = urlCode || localStorage.getItem('gp_code') || '';
  } catch (_) {
    /* ignore */
  }
  if (savedCode) {
    el.participationInput.value = savedCode.trim();
    rememberCode(savedCode.trim());
  }
  try {
    const cfg = await fetch('/api/config').then((r) => r.json());
    applyParticipationConfig(!!cfg.participationRequired, !!savedCode.trim());
  } catch (_) {
    /* ignore */
  }

  await refreshMine();
  GP.startPolling();
})();
