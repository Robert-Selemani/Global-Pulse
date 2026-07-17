# Global Pulse — Interactive Community Map

An open-source, interactive world map for **visualizing and tracking
communities** across countries. Built as a precise, community-aware
alternative to generic audience-polling tools (e.g. Mentimeter), following the
*Software Functionality Document* in [`docs/`](./docs).

![Green countries have communities; each shows its unique-community count and a participant pin.](https://img.shields.io/badge/status-ready-2fd27a)

## Why

Existing polling platforms have two big weaknesses this tool fixes:

- **Imprecise pin-dropping**, especially for geographically small countries.
  Global Pulse replaces free pin-drops with **exact country-level selection**.
- **Attendee counts only** — no sense of *which* communities are present.
  Global Pulse tracks **unique communities** per country via normalized
  free-text input, so new and emerging groups are discovered, not just counted.

## Features

| Requirement | How it works |
| --- | --- |
| **Country selection** | Choose from a predefined list (dropdown or click the map). |
| **Community input** | Free-text field; new communities are catalogued automatically. |
| **Flag fill** | Represented countries are filled with their **national flag**; others stay neutral grey. The map shows no numbers — all counts live in the sidebar. |
| **Counts in the sidebar** | Per-country community + participant counts live in the sidebar, not on the map. |
| **Always-on country list** | A "Countries represented" panel always lists every represented country and its counts — even while a country is selected for entry. |
| **Selected-country detail** | Lists every unique community in the selected country with member counts. Includes a **Clear selection** button. |
| **Accounts & roles** | Email/password sign-up. The **first account is the super admin**; the rest are end users. Any account can create polls. |
| **Multiple polls & past-poll history** | Each organizer runs **many polls over time**. Every poll has its own map, submissions, and join code, and can be **archived** — archived polls become read-only and move to **Past polls**, where their results stay viewable. |
| **Organizer dashboard** | A `/dashboard` page to create polls, copy join links + QR, set/clear codes, **export CSV**, archive, and delete. |
| **Subscription plans** | Accounts carry a **subscription** (Free / Pro / Business) in the database. *Schema only for now — no billing and no limits enforced yet.* |
| **Presentation vs. voting pages** | A public **presentation** page (`/p/<slug>`) for screens and a login-gated **voting** page for participation. |
| **Self-service edit/withdraw** | Logged-in users can **edit** or **withdraw** their own submissions (ownership enforced server-side). |
| **Participation code + QR** | A poll's organizer can generate a **participation code** and **QR code** for attendees to join; when set, a valid code is required to submit. Codes are **per poll**. |
| **CSV export** | Organizers can download any poll's raw submissions as CSV. |
| **Deduplication & normalization** | `AI Eswatini`, `ai eswatini`, and `ai-eswatini!` collapse to one community (case-insensitive, punctuation/whitespace-insensitive). |
| **Live updates** | The map polls the server so an audience sees entries appear in near real-time. |
| **Participant zoom/pan** | Everyone can freely pan and zoom with a **custom-percentage slider** (smooth, continuous zoom) plus a live zoom-% readout. |

## Pages

| Page | URL | Who | Purpose |
| --- | --- | --- | --- |
| **Poll presentation** | `/p/<slug>` | Public | One poll's live map for display on screens — flags, "Countries represented", and running totals. Read-only. |
| **Dashboard** | `/dashboard` | Logged-in users | Create and manage **your polls**: join links + QR, codes, CSV export, archive, delete. Lists **active** and **past** polls. |
| **Voting** | `/vote?poll=<slug>` | Logged-in users | Add / edit / withdraw your community in that poll; zoom & pan. |
| **Presentation (default)** | `/` (or `/present`) | Public | The legacy/default poll's map, for installs migrated from the original single-poll app. |
| **Sign up** | `/signup` | Anyone | Create an account. **The first account becomes the super admin.** |
| **Log in** | `/login` | Anyone with an account | Sign in. |

## Roles

Accounts are email + password (passwords hashed with `scrypt`). **The first
person to sign up is the super admin; everyone who signs up afterwards is an
end user.** **Any account can create polls** and becomes the organizer (owner)
of the polls it creates.

- **End user / participant:** add communities and **edit or withdraw their own
  submissions**, browse the sidebar, and freely **zoom and pan** the map. When a
  poll has a participation code, they enter it (or arrive via the QR link) to
  submit.
- **Organizer (any account):** everything above, plus a **dashboard** for the
  polls they own — create polls, generate/regenerate/remove each poll's
  **participation code + QR**, **export CSV**, and **archive** or delete.
- **Super admin (first account):** everything above, and may manage **any**
  poll on the platform.

## Polls & past-poll history

The app is **multi-poll**: an organizer runs a separate poll per event, and each
poll keeps its own submissions, participation code, and results.

- A poll is created from `/dashboard` and gets a URL **slug** from its title
  (e.g. *AI Summit 2026* → `ai-summit-2026`).
- Share `/vote?poll=<slug>` (or the QR code) with attendees; present at
  `/p/<slug>`.
- **Archiving** a poll makes it read-only — submissions are blocked, but the
  results stay viewable and it moves to **Past polls** on the dashboard.

> Upgrading from the original single-poll version? On first boot all existing
> submissions (and the old global participation code) are **migrated
> automatically** into one poll titled *Global Pulse* (`/p/global-pulse`), owned
> by the super admin. Nothing is lost.

## Architecture

```
Global-Pulse/
├── server/
│   └── index.js         # Zero-dependency Node HTTP API + auth + static host
├── client/
│   ├── present.html     # Presentation page (public live screen)
│   ├── vote.html        # Voting page (requires login)
│   ├── dashboard.html   # Organizer dashboard (polls, codes, export)
│   ├── login.html       # Log in
│   ├── signup.html      # Sign up (first user = super admin)
│   ├── mapcore.js       # Shared map + rendering core (window.GP)
│   ├── present.js       # Presentation page logic (per-poll)
│   ├── vote.js          # Voting page logic (entry, self-service)
│   ├── dashboard.js     # Dashboard logic (poll CRUD, QR, CSV, plan)
│   ├── auth.js          # Login / signup logic
│   ├── styles.css       # Styling
│   ├── vendor/leaflet/  # Self-hosted Leaflet (no CDN dependency)
│   ├── vendor/qrcode/   # Self-hosted QR-code generator
│   └── data/
│       ├── countries.geo.json   # World country polygons (ISO A3 ids)
│       ├── continents.json      # ISO A3 → continent mapping
│       └── flags.json           # ISO A3 → ISO A2 (for flag images)
├── docs/                # Software Functionality Document
├── render.yaml          # Render deploy blueprint (web service + disk)
├── .env.example         # Documented environment variables
└── package.json
```

- **Backend:** plain Node.js (`node:http`), one dependency (`pg`).
  Persistence is **pluggable**: PostgreSQL when `DATABASE_URL` is set
  (production), or a JSON file otherwise (local dev). Adds security headers,
  admin sessions (signed HttpOnly cookies), and login rate limiting.
- **Frontend:** vanilla JS + [Leaflet](https://leafletjs.com/) rendering a
  GeoJSON map. Represented countries are filled with their flag via SVG
  patterns (flag images from [flagcdn.com](https://flagcdn.com)). **Leaflet is
  vendored** into `client/vendor/` so the core map has no runtime CDN
  dependency.

### API

**Poll-scoped (participants & presentation)** — `:slug` is the poll's slug:

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/poll/:slug/data` | Aggregated per-country communities & counts for that poll. |
| `GET` | `/api/poll/:slug/config` | `{ title, status, participationRequired }`. |
| `POST` | `/api/poll/:slug/submit` | Add an entry `{ countryId, countryName, community, code }` (login required; blocked when archived). |
| `GET` | `/api/poll/:slug/mine` | The logged-in user's own submissions in that poll. |
| `PUT` | `/api/poll/:slug/submission/:id` | Edit one's own submission (ownership enforced). |
| `DELETE` | `/api/poll/:slug/submission/:id` | Withdraw one's own submission. |

**Poll management (owner or super admin)**:

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/polls` | List the signed-in user's polls (with counts). |
| `POST` | `/api/polls` | Create a poll `{ title, description }` → returns it with its slug. |
| `GET`/`PUT`/`DELETE` | `/api/polls/:id` | Read / rename / delete a poll (delete removes its submissions). |
| `POST` | `/api/polls/:id/archive` | End & archive a poll (becomes read-only). |
| `POST`/`DELETE` | `/api/polls/:id/code` | Generate / remove that poll's participation code. |
| `GET` | `/api/polls/:id/export` | Download the poll's submissions as CSV. |

**Accounts & subscriptions**:

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/signup` | Create an account `{ email, password }`; first account = super admin. |
| `POST` | `/api/login` | Log in `{ email, password }`; sets a session cookie. |
| `POST` | `/api/logout` | Clears the session. |
| `GET` | `/api/session` | Current auth state: `{ authenticated, email, role, isSuperAdmin, hasUsers }`. |
| `GET` | `/api/plans` | Available subscription plans (public). |
| `GET`/`POST` | `/api/subscription` | Read / set the current user's plan. *Schema only — no billing.* |
| `GET` | `/api/data`, `/api/config` | Legacy aliases resolving to the default (migrated) poll. |
| `GET` | `/api/health` | Liveness + submission count. |

### Environment variables

See [`.env.example`](./.env.example). Key ones:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string. When set, data is stored in Postgres; otherwise a JSON file is used. |
| `SESSION_SECRET` | Signs session cookies. Use a long random string. |
| `DATA_DIR` | Directory for the JSON-file fallback (only when `DATABASE_URL` is unset). |
| `PORT` | Port to listen on (Render sets this automatically). |

## Running locally

Requires **Node.js 18+**. No install step needed.

```bash
git clone https://github.com/Robert-Selemani/Global-Pulse.git
cd Global-Pulse
npm start            # or: node server/index.js
```

Then open <http://localhost:3000>. Go to `/signup` to create the **first
account (the super admin)** — you'll land on `/dashboard`. Create a poll there,
then share its join link (`/vote?poll=<slug>`) or QR with participants and
present it at `/p/<slug>`. Set a custom port with `PORT=8080 npm start`.

## Deploying to Render

This is a **Node web service** (not a static site) backed by **Render
Postgres**. A [`render.yaml`](./render.yaml) blueprint provisions both.

### Option A — Blueprint (recommended)

1. Push this repo to GitHub.
2. In Render: **New → Blueprint**, and point it at this repository.
3. Render reads `render.yaml` and provisions a **web service + a managed
   PostgreSQL database**, wiring `DATABASE_URL` into the service automatically.
   Click **Apply**. `SESSION_SECRET` is generated automatically.
4. Open the deployed URL and go to `/signup` — **the first account you create
   is the super admin.** Do this promptly after deploy, then create your first
   poll from `/dashboard`.

### Option B — Manual

1. **New → PostgreSQL** — create a database, copy its connection string.
2. **New → Web Service** from your GitHub repo. Runtime **Node**,
   Build `npm install`, Start `npm start`.
3. Add env vars: `DATABASE_URL=<connection string>` and a long random
   `SESSION_SECRET`.

### Data persistence

With `DATABASE_URL` set, all data is written to PostgreSQL, so it **survives
deploys and restarts** and the app can run multiple instances. The schema is
created (and migrated) automatically on first boot.

| Table | Holds |
| --- | --- |
| `users` | Accounts: email, `scrypt` password hash, role, created-at. |
| `polls` | One row per poll: owner, title, unique `slug`, description, `status` (`active`/`archived`), its participation code, settings, created/archived timestamps. |
| `submissions` | Every community entry, scoped to a poll via `poll_id` and to a participant via `participant_id`. |
| `plans` | Subscription tiers (`free`, `pro`, `business`) with price and limits. Seeded on boot. |
| `subscriptions` | One row per user: their plan, status, and provider fields (`stripe` etc.) reserved for future billing. |
| `settings` | Small global key/value store. |

> **Subscriptions are schema only.** Plan limits (`max_polls`,
> `max_participants`) are stored but **not enforced**, and no payment provider
> is wired up. The provider columns exist so billing can be added without a
> further migration.

Locally, `DATABASE_URL` is unset, so the app falls back to a JSON file
(`server/data.json`) with the same shape — no database required for
development. Both backends implement the identical store interface, so they
behave the same.

> **Note:** The blueprint uses the `starter` web plan and a `basic-256mb`
> Postgres plan (both paid). Adjust the plans in `render.yaml` to taste.

## Phased implementation (per the spec)

- **Phase 1 — Country representation:** country selection, map coloring, and
  total participant counts per country. ✅
- **Phase 2 — Unique community tracking:** free-text input with real-time
  deduplication, unique-community counts per country, and the live sidebar. ✅
- **Phase 3 — Multi-poll platform:** accounts own many polls, per-poll join
  codes, archiving with **past-poll history**, CSV export, and a subscription
  schema on every account. ✅

### Not yet wired up

Billing (Stripe) and plan-limit enforcement, email verification / password
reset, and real-time updates via SSE (the map currently polls).

## License

MIT
