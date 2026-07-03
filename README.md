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
| **Accounts & roles** | Email/password sign-up. The **first account is the super admin**; the rest are end users. |
| **Presentation vs. voting pages** | A public **presentation** page for screens and a login-gated **voting** page for participation. |
| **Self-service edit/withdraw** | Logged-in users can **edit** or **withdraw** their own submissions (ownership enforced server-side). |
| **Participation code + QR** | A super admin can generate a **participation code** and **QR code** for attendees to join; when set, a valid code is required to submit. |
| **Deduplication & normalization** | `AI Eswatini`, `ai eswatini`, and `ai-eswatini!` collapse to one community (case-insensitive, punctuation/whitespace-insensitive). |
| **Live updates** | The map polls the server so an audience sees entries appear in near real-time. |
| **Super admin continent focus** | The super admin can focus the map on a continent (zoom + dim others + filter the country list). |
| **Participant zoom/pan** | Everyone can freely pan and zoom with a **custom-percentage slider** (smooth, continuous zoom) plus a live zoom-% readout. |

## Pages

| Page | URL | Who | Purpose |
| --- | --- | --- | --- |
| **Presentation** | `/` (or `/present`) | Public | The live map for display on screens — flags, "Countries represented", and running totals. Read-only. |
| **Voting** | `/vote` | Logged-in users | Add / edit / withdraw your community; zoom & pan. |
| **Sign up** | `/signup` | Anyone | Create an account. **The first account becomes the super admin.** |
| **Log in** | `/login` | Anyone with an account | Sign in. |

## Roles

Accounts are email + password (passwords hashed with `scrypt`). **The first
person to sign up is the super admin; everyone who signs up afterwards is an
end user.**

- **End user:** add communities and **edit or withdraw their own submissions**,
  browse the sidebar, and freely **zoom and pan** the map (custom-percentage
  slider). When a participation code is set, they enter it (or arrive via the
  QR link) to submit.
- **Super admin:** everything above, plus a **continent-focus** control and a
  **participation-code + QR** panel (generate/regenerate/disable the code
  attendees use to join).

Set the admin password with the `ADMIN_PASSWORD` environment variable.

## Architecture

```
Global-Pulse/
├── server/
│   └── index.js         # Zero-dependency Node HTTP API + auth + static host
├── client/
│   ├── present.html     # Presentation page (public live screen)
│   ├── vote.html        # Voting page (requires login)
│   ├── login.html       # Log in
│   ├── signup.html      # Sign up (first user = super admin)
│   ├── mapcore.js       # Shared map + rendering core (window.GP)
│   ├── present.js       # Presentation page logic
│   ├── vote.js          # Voting page logic (entry, self-service, admin)
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

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/data` | Aggregated per-country communities & counts. |
| `GET` | `/api/config` | Whether a participation code is currently required. |
| `POST` | `/api/submit` | Add an entry `{ countryId, countryName, community, code }` (must be logged in; owner = session user). |
| `GET` | `/api/mine` | The logged-in user's own submissions (for edit/withdraw). |
| `PUT` | `/api/submission/:id` | Edit one's own submission (ownership by session user). |
| `DELETE` | `/api/submission/:id` | Withdraw one's own submission. |
| `POST` | `/api/signup` | Create an account `{ email, password }`; first account = super admin. |
| `POST` | `/api/login` | Log in `{ email, password }`; sets a session cookie. |
| `POST` | `/api/logout` | Clears the session. |
| `GET` | `/api/session` | Current auth state: `{ authenticated, email, role, isSuperAdmin, hasUsers }`. |
| `GET`/`POST`/`DELETE` | `/api/admin/code` | Super admin: read / generate / disable the participation code. |
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

Then open <http://localhost:3000> (the presentation page). Go to
`/signup` to create the **first account (the super admin)**, then use `/vote`
to participate. Set a custom port with `PORT=8080 npm start`.

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
   is the super admin.** Do this promptly after deploy.

### Option B — Manual

1. **New → PostgreSQL** — create a database, copy its connection string.
2. **New → Web Service** from your GitHub repo. Runtime **Node**,
   Build `npm install`, Start `npm start`.
3. Add env vars: `DATABASE_URL=<connection string>` and a long random
   `SESSION_SECRET`.

### Data persistence

With `DATABASE_URL` set, every submission is written to a `submissions` table
in Postgres, so data **survives deploys and restarts** and the app can run
multiple instances. The schema is created automatically on first boot.

Locally, `DATABASE_URL` is unset, so the app falls back to a JSON file
(`server/data.json`) — no database required for development.

> **Note:** The blueprint uses the `starter` web plan and a `basic-256mb`
> Postgres plan (both paid). Adjust the plans in `render.yaml` to taste.

## Phased implementation (per the spec)

- **Phase 1 — Country representation:** country selection, map coloring, and
  total participant counts per country. ✅
- **Phase 2 — Unique community tracking:** free-text input with real-time
  deduplication, unique-community counts per country, and the live sidebar. ✅

## License

MIT
