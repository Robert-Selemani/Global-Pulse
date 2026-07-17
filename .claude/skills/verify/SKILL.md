---
name: verify
description: Build, run, and drive Global Pulse end-to-end to verify a change actually works — starts the server on the JSON file-store and drives the real UI in Chrome via Playwright.
---

# Verifying Global Pulse

Zero-install Node app (`node:http` + `pg`). Node 18+. Two surfaces worth
driving: the **HTTP API** (curl) and the **browser UI** (Playwright/Chrome).

## Launch

No `DATABASE_URL` → the app uses the JSON file store, so **no database is
needed**. Always point `DATA_DIR` at a scratch dir so you never clobber the
repo's `server/data.json`:

```bash
export DATA_DIR=/tmp/gp-verify && mkdir -p "$DATA_DIR"
export SESSION_SECRET=test-secret PORT=3996
rm -f "$DATA_DIR/data.json"          # fresh store; omit to test migration
node server/index.js &
```

`rm` the `data.json` between runs — signup only makes the **first** account the
super admin, and slugs collide across runs otherwise.

## Drive the UI (Playwright)

Chrome is installed; use `channel: 'chrome'` to skip downloading Chromium:

```js
const { chromium } = require('playwright');
const b = await chromium.launch({ channel: 'chrome' });
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();   // note: newContext() then newPage()
```

**Gotcha:** country `<option>` values are **ISO A3** (`SWZ`, `KEN`), not ISO2.
`client/data/countries.geo.json` is the source of truth. Wait for the select to
populate — it loads 242 features:

```js
await page.waitForFunction(
  () => document.querySelectorAll('#country-select option').length > 100);
await page.selectOption('#country-select', 'SWZ');
```

## The flow worth driving

1. `/signup` (first account = super admin) → redirects to `/dashboard`
2. Create a poll → `.poll-card` appears; slug derives from the title
3. "Set code" → `.code-pill` + QR render
4. `/vote?poll=<slug>&code=<code>` → select country, submit → `#form-message` gets ✅
5. `/p/<slug>` → stats update; a **second poll must stay at 0** (isolation)
6. Dashboard → "Archive" (accept the `confirm` dialog: `page.once('dialog', d => d.accept())`)
7. `/vote?poll=<slug>` on an archived poll → `#submit-btn` disabled, read-only message
8. `/p/<slug>` archived → results still render, ARCHIVED badge, Participate link hidden

## Probes that matter

Poll-scoping and ownership are the risky seams — check with curl:

- Non-owner hits `/api/polls/:id{,/archive,/code,/export}` → **403**
- Edit/delete a submission through the **wrong poll slug** → **403**
- Duplicate titles → `slug`, `slug-2`, `slug-3`
- `DELETE /api/polls/:id` → its submissions are gone (no orphans in `data.json`)

## Known noise

`GET /favicon.ico` → **404** on every page load. Pre-existing (no favicon file
exists); it shows up as a console error in Playwright. Not a regression.
