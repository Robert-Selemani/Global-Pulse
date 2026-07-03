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
| **Map coloring** | Countries with ≥1 community turn **green**; others stay neutral. |
| **Unique community count** | Shown in a bubble at the centre of each active country. |
| **Participant pin** | Total users who selected each country, pinned at its centre. |
| **Sidebar listing** | Lists every unique community in the selected country with member counts. |
| **Deduplication & normalization** | `AI Eswatini`, `ai eswatini`, and `ai-eswatini!` collapse to one community (case-insensitive, punctuation/whitespace-insensitive). |
| **Live updates** | The map polls the server so an audience sees entries appear in near real-time. |
| **Admin continent focus** | A logged-in admin can focus the map on a continent (zoom + dim others + filter the country list). |
| **Participant zoom/pan** | Everyone can freely zoom (with a live zoom-% readout) and pan to choose their own view. |

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
│       └── continents.json      # ISO A3 → continent mapping
├── docs/                # Software Functionality Document
├── render.yaml          # Render deploy blueprint (web service + disk)
├── .env.example         # Documented environment variables
└── package.json
```

- **Backend:** plain Node.js (`node:http`) — **no dependencies, no build
  step**. Submissions are stored in `DATA_DIR/data.json` and aggregated on
  read. Adds security headers, admin sessions (signed HttpOnly cookies), and
  login rate limiting.
- **Frontend:** vanilla JS + [Leaflet](https://leafletjs.com/) rendering a
  GeoJSON choropleth. **Leaflet is vendored** into `client/vendor/` so the app
  has no runtime CDN dependency (this also fixes CDN/SRI failures that could
  blank the map).

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
| `ADMIN_PASSWORD` | Password for the admin continent-focus control. **Set this.** |
| `SESSION_SECRET` | Signs admin session cookies. Use a long random string. |
| `DATA_DIR` | Directory for `data.json` (a persistent disk in production). |
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

This is a **Node web service** (not a static site) because it runs an API and
persists submissions. A [`render.yaml`](./render.yaml) blueprint is included.

### Option A — Blueprint (recommended)

1. Push this repo to GitHub.
2. In Render: **New → Blueprint**, and point it at this repository.
3. Render reads `render.yaml` and provisions a web service **with a 1 GB
   persistent disk** mounted at `/var/data`. Click **Apply**.
4. When prompted, set **`ADMIN_PASSWORD`** (it's marked `sync: false` so it is
   never stored in the repo). `SESSION_SECRET` is generated automatically.

### Option B — Manual

1. **New → Web Service** from your GitHub repo.
2. Runtime **Node**, Build `npm install`, Start `npm start`.
3. Add a **Disk**: mount path `/var/data`, size 1 GB.
4. Add env vars: `DATA_DIR=/var/data`, `ADMIN_PASSWORD=<your password>`, and a
   long random `SESSION_SECRET`.

### Data persistence

Submissions are written to `DATA_DIR/data.json`. Pointing `DATA_DIR` at the
mounted disk means data **survives deploys and restarts**. Without a disk,
Render's filesystem is ephemeral and data resets on restart.

> **Note:** Persistent disks require a **paid** instance type (the Free tier
> does not support disks). The blueprint uses the `starter` plan. A service
> with a disk cannot scale beyond one instance, which is expected here.

Locally, `DATA_DIR` is unset, so data is stored in `server/data.json`.

## Phased implementation (per the spec)

- **Phase 1 — Country representation:** country selection, map coloring, and
  total participant counts per country. ✅
- **Phase 2 — Unique community tracking:** free-text input with real-time
  deduplication, unique-community counts per country, and the live sidebar. ✅

## License

MIT
