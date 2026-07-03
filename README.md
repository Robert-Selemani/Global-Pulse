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

## Architecture

```
Global-Pulse/
├── server/
│   └── index.js         # Zero-dependency Node HTTP API + static host
├── client/
│   ├── index.html       # App shell
│   ├── styles.css       # Styling
│   ├── app.js           # Leaflet map + sidebar logic
│   └── data/
│       └── countries.geo.json   # World country polygons (ISO A3 ids)
├── docs/                # Software Functionality Document
└── package.json
```

- **Backend:** plain Node.js (`node:http`) — **no dependencies, no build
  step**. Submissions are stored in `server/data.json` and aggregated on read.
- **Frontend:** vanilla JS + [Leaflet](https://leafletjs.com/) (loaded from
  CDN) rendering a GeoJSON choropleth.

### API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/data` | Aggregated per-country communities & counts. |
| `POST` | `/api/submit` | Add a `{ countryId, countryName, community }` entry. |
| `GET` | `/api/health` | Liveness + submission count. |

## Running locally

Requires **Node.js 18+**. No install step needed.

```bash
git clone https://github.com/Robert-Selemani/Global-Pulse.git
cd Global-Pulse
npm start            # or: node server/index.js
```

Then open <http://localhost:3000>.

Set a custom port with `PORT=8080 npm start`.

## Deploying to Render

This is a **Node web service** (not a static site) because it runs an API and
persists submissions. A [`render.yaml`](./render.yaml) blueprint is included.

### Option A — Blueprint (recommended)

1. Push this repo to GitHub.
2. In Render: **New → Blueprint**, and point it at this repository.
3. Render reads `render.yaml` and provisions a web service **with a 1 GB
   persistent disk** mounted at `/var/data`. Click **Apply**.

### Option B — Manual

1. **New → Web Service** from your GitHub repo.
2. Runtime **Node**, Build `npm install`, Start `npm start`.
3. Add a **Disk**: mount path `/var/data`, size 1 GB.
4. Add an env var `DATA_DIR=/var/data`.

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
