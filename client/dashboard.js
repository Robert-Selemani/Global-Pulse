/* global qrcode */
'use strict';

/**
 * Organizer dashboard. Lists the signed-in user's polls (active and past),
 * lets them create polls, manage each poll's participation code + QR, export
 * results as CSV, and archive or delete polls.
 */

const $ = (id) => document.getElementById(id);
const el = {
  accountEmail: $('account-email'),
  planChip: $('plan-chip'),
  logoutBtn: $('logout-btn'),
  createForm: $('create-form'),
  titleInput: $('poll-title-input'),
  descInput: $('poll-desc-input'),
  createBtn: $('create-btn'),
  createMessage: $('create-message'),
  activePolls: $('active-polls'),
  pastPolls: $('past-polls'),
  activeCount: $('active-count'),
  pastCount: $('past-count'),
  activeEmpty: $('active-empty'),
  pastEmpty: $('past-empty'),
};

function setCreateMessage(text, kind) {
  el.createMessage.textContent = text || '';
  el.createMessage.className = 'form-message' + (kind ? ' ' + kind : '');
}

function fmtDate(ms) {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch (_) {
    return '';
  }
}

function joinUrl(poll) {
  const base = location.origin + '/vote?poll=' + encodeURIComponent(poll.slug);
  return poll.participationCode ? base + '&code=' + encodeURIComponent(poll.participationCode) : base;
}

function renderQr(container, text) {
  container.innerHTML = '';
  try {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    container.innerHTML = qr.createImgTag(4, 8);
    const img = container.querySelector('img');
    if (img) img.alt = 'QR code to join';
  } catch (_) {
    container.textContent = text;
  }
}

// ---------------------------------------------------------------------------
// Poll actions (API calls)
// ---------------------------------------------------------------------------
async function apiJson(url, options) {
  const res = await fetch(url, options);
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || 'Request failed');
  return payload;
}

async function setCode(poll) {
  await apiJson('/api/polls/' + poll.id + '/code', { method: 'POST' });
  await loadPolls();
}
async function clearCode(poll) {
  if (!window.confirm('Remove the participation code? Anyone signed in can then join.')) return;
  await apiJson('/api/polls/' + poll.id + '/code', { method: 'DELETE' });
  await loadPolls();
}
async function archivePoll(poll) {
  if (!window.confirm('Archive "' + poll.title + '"? It becomes read-only and moves to Past polls.'))
    return;
  await apiJson('/api/polls/' + poll.id + '/archive', { method: 'POST' });
  await loadPolls();
}
async function deletePoll(poll) {
  if (
    !window.confirm(
      'Delete "' + poll.title + '" and all its submissions? This cannot be undone.'
    )
  )
    return;
  await apiJson('/api/polls/' + poll.id, { method: 'DELETE' });
  await loadPolls();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function actionBtn(label, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'mini-btn' + (cls ? ' ' + cls : '');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function pollCard(poll) {
  const archived = poll.status === 'archived';
  const card = document.createElement('article');
  card.className = 'poll-card' + (archived ? ' archived' : '');

  // Header: title + status
  const head = document.createElement('div');
  head.className = 'poll-card-head';
  const h = document.createElement('h3');
  h.textContent = poll.title;
  head.appendChild(h);
  const tag = document.createElement('span');
  tag.className = 'status-tag ' + poll.status;
  tag.textContent = archived ? 'Archived' : 'Active';
  head.appendChild(tag);
  card.appendChild(head);

  if (poll.description) {
    const d = document.createElement('p');
    d.className = 'poll-desc';
    d.textContent = poll.description;
    card.appendChild(d);
  }

  // Meta: counts + dates
  const meta = document.createElement('p');
  meta.className = 'poll-meta';
  meta.textContent =
    poll.submissionCount +
    (poll.submissionCount === 1 ? ' participant' : ' participants') +
    ' · ' +
    poll.communityCount +
    (poll.communityCount === 1 ? ' community' : ' communities') +
    ' · ' +
    (archived ? 'archived ' + fmtDate(poll.archivedAt) : 'created ' + fmtDate(poll.createdAt));
  card.appendChild(meta);

  // Participation code + QR (active polls only)
  if (!archived) {
    const codeBox = document.createElement('div');
    codeBox.className = 'poll-code';
    if (poll.participationCode) {
      const codeLine = document.createElement('div');
      codeLine.className = 'code-line';
      codeLine.innerHTML =
        'Join code: <span class="code-pill">' + poll.participationCode + '</span>';
      codeBox.appendChild(codeLine);
      const qr = document.createElement('div');
      qr.className = 'qr-box small';
      renderQr(qr, joinUrl(poll));
      codeBox.appendChild(qr);
    } else {
      const open = document.createElement('p');
      open.className = 'hint';
      open.textContent = 'No code — anyone signed in can join.';
      codeBox.appendChild(open);
    }
    card.appendChild(codeBox);
  }

  // Actions
  const actions = document.createElement('div');
  actions.className = 'poll-actions';

  const present = actionBtn(archived ? 'View results' : 'Open results', '', () => {
    window.open('/p/' + poll.slug, '_blank');
  });
  actions.appendChild(present);

  if (!archived) {
    actions.appendChild(
      actionBtn('Copy join link', '', async (e) => {
        try {
          await navigator.clipboard.writeText(joinUrl(poll));
          e.target.textContent = 'Copied ✓';
          setTimeout(() => (e.target.textContent = 'Copy join link'), 1500);
        } catch (_) {
          window.prompt('Copy this join link:', joinUrl(poll));
        }
      })
    );
    actions.appendChild(
      actionBtn(poll.participationCode ? 'Regenerate code' : 'Set code', '', () =>
        setCode(poll).catch((err) => alert(err.message))
      )
    );
    if (poll.participationCode) {
      actions.appendChild(actionBtn('Remove code', '', () => clearCode(poll).catch((err) => alert(err.message))));
    }
  }

  // Export CSV (plain link so the auth cookie is sent).
  const exportLink = document.createElement('a');
  exportLink.className = 'mini-btn';
  exportLink.href = '/api/polls/' + poll.id + '/export';
  exportLink.textContent = 'Export CSV';
  actions.appendChild(exportLink);

  if (!archived) {
    actions.appendChild(actionBtn('Archive', '', () => archivePoll(poll).catch((err) => alert(err.message))));
  }
  actions.appendChild(
    actionBtn('Delete', 'danger', () => deletePoll(poll).catch((err) => alert(err.message)))
  );

  card.appendChild(actions);
  return card;
}

function renderPolls(polls) {
  const active = polls.filter((p) => p.status !== 'archived');
  const past = polls.filter((p) => p.status === 'archived');

  el.activePolls.innerHTML = '';
  el.pastPolls.innerHTML = '';
  el.activeEmpty.hidden = active.length > 0;
  el.pastEmpty.hidden = past.length > 0;
  el.activeCount.textContent = active.length ? String(active.length) : '';
  el.pastCount.textContent = past.length ? String(past.length) : '';

  for (const p of active) el.activePolls.appendChild(pollCard(p));
  for (const p of past) el.pastPolls.appendChild(pollCard(p));
}

async function loadPolls() {
  const { polls } = await apiJson('/api/polls');
  renderPolls(polls || []);
}

async function loadPlan() {
  try {
    const [{ subscription }, { plans }] = await Promise.all([
      apiJson('/api/subscription'),
      apiJson('/api/plans'),
    ]);
    if (!subscription) return;
    const plan = plans.find((p) => p.id === subscription.planId);
    el.planChip.textContent = 'Plan: ' + (plan ? plan.name : subscription.planId);
    el.planChip.hidden = false;
  } catch (_) {
    /* plan chip is optional */
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
el.createForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = el.titleInput.value.trim();
  if (!title) return setCreateMessage('Please enter a poll title.', 'error');
  el.createBtn.disabled = true;
  setCreateMessage('Creating…', '');
  try {
    await apiJson('/api/polls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description: el.descInput.value.trim() }),
    });
    el.titleInput.value = '';
    el.descInput.value = '';
    setCreateMessage('Poll created ✅', 'success');
    await loadPolls();
  } catch (err) {
    setCreateMessage(err.message, 'error');
  } finally {
    el.createBtn.disabled = false;
  }
});

el.logoutBtn.addEventListener('click', async () => {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch (_) {
    /* ignore */
  }
  location.href = '/present';
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async function boot() {
  let session;
  try {
    session = await fetch('/api/session').then((r) => r.json());
  } catch (_) {
    session = { authenticated: false };
  }
  if (!session.authenticated) {
    location.href = '/login?next=' + encodeURIComponent('/dashboard');
    return;
  }
  if (el.accountEmail) el.accountEmail.textContent = session.email;
  await Promise.all([loadPlan(), loadPolls().catch((err) => setCreateMessage(err.message, 'error'))]);
})();
