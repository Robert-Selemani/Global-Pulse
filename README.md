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
| **Flag fill** | Represented countries are filled with their **national flag**; others stay neutral grey. |
| **Participant pin** | Total users who selected each country, pinned at its centre. |
| **Counts in the sidebar** | Per-country community + participant counts live in the sidebar, not on the map. |
| **Always-on country list** | A "Countries represented" panel always lists every represented country and its counts — even while a country is selected for entry. |
| **Selected-country detail** | Lists every unique community in the selected country with member counts. |
| **Deduplication & normalization** | `AI Eswatini`, `ai eswatini`, and `ai-eswatini!` collapse to one community (case-insensitive, punctuation/whitespace-insensitive). |
| **Live updates** | The map polls the server so an audience sees entries appear in near real-time. |
| **Admin continent focus** | A logged-in admin can focus the map on a continent (zoom + dim others + filter the country list). |
| **Participant zoom/pan** | Everyone can freely pan and zoom with a **custom-percentage slider** (smooth, continuous zoom) plus a live zoom-% readout. |

## Roles

- **Participants (default):** add communities, browse the sidebar, and freely
  **zoom and pan** the map. A live zoom-percentage readout helps them dial in
  their view. They do **not** see the continent-focus control.
- **Admin (password-protected):** everything above, plus a **continent-focus**
  control that zooms the map to a continent, dims countries elsewhere, and
  filters the country picker. Sign in via **Admin login** in the header.

Set the admin password with the `ADMIN_PASSWORD` environment variable.

## Architecture

```
Global-Pulse/
├── server/
│   └── index.js         # Zero-dependency Node HTTP API + auth + static host
├── client/
│   ├── index.html       # App shell
│   ├── styles.css       # Styling
│   ├── app.js           # Leaflet map + sidebar + admin logic
│   ├── vendor/leaflet/  # Self-hosted Leaflet (no CDN dependency)
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
| `POST` | `/api/submit` | Add a `{ countryId, countryName, community }` entry. |
| `GET` | `/api/session` | Whether the caller is an authenticated admin. |
| `POST` | `/api/login` | Admin login with `{ password }`; sets a session cookie. |
| `POST` | `/api/logout` | Clears the admin session. |
| `GET` | `/api/health` | Liveness + submission count. |

### Environment variables

See [`.env.example`](./.env.example). Key ones:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string. When set, data is stored in Postgres; otherwise a JSON file is used. |
| `ADMIN_PASSWORD` | Password for the admin continent-focus control. **Set this.** |
| `SESSION_SECRET` | Signs admin session cookies. Use a long random string. |
| `DATA_DIR` | Directory for the JSON-file fallback (only when `DATABASE_URL` is unset). |
| `PORT` | Port to listen on (Render sets this automatically). |

## Running locally

Requires **Node.js 18+**. No install step needed.

```bash
git clone https://github.com/Robert-Selemani/Global-Pulse.git
cd Global-Pulse
npm start            # or: node server/index.js
```

Then open <http://localhost:3000>.

To try the admin continent-focus control locally, set a password first:

```bash
ADMIN_PASSWORD=secret npm start
```

Then click **Admin login** in the header and enter the password. Set a custom
port with `PORT=8080 npm start`.

## Deploying to Render

This is a **Node web service** (not a static site) backed by **Render
Postgres**. A [`render.yaml`](./render.yaml) blueprint provisions both.

### Option A — Blueprint (recommended)

1. Push this repo to GitHub.
2. In Render: **New → Blueprint**, and point it at this repository.
3. Render reads `render.yaml` and provisions a **web service + a managed
   PostgreSQL database**, wiring `DATABASE_URL` into the service automatically.
   Click **Apply**.
4. When prompted, set **`ADMIN_PASSWORD`** (marked `sync: false`, so it is
   never stored in the repo). `SESSION_SECRET` is generated automatically.

### Option B — Manual

1. **New → PostgreSQL** — create a database, copy its connection string.
2. **New → Web Service** from your GitHub repo. Runtime **Node**,
   Build `npm install`, Start `npm start`.
3. Add env vars: `DATABASE_URL=<connection string>`,
   `ADMIN_PASSWORD=<your password>`, and a long random `SESSION_SECRET`.

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
