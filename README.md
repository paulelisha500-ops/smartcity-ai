---
title: SmartCity AI
emoji: 🏙️
colorFrom: blue
colorTo: green
sdk: docker
app_port: 7860
pinned: false
---

# SmartCity AI — Intelligent Urban Planning & Traffic Management Platform

A production-style platform for a UAE smart-city evaluation. Twelve modules
covering traffic analysis, citizen services, emergency response, and long-range
infrastructure planning — running on the **real UAE road network**, with a
**real CCTV integration layer**, on a laptop, with no GPU and no paid API keys.

## What is actually real here

This started as a POC skeleton with mock services behind clean interfaces.
Several of those interfaces now have genuine implementations:

| Area | What it does for real |
|---|---|
| **Road network** | ~171,000 road links / ~50,000 km — motorways down to residential streets — across all seven emirates including Al Ain, Hatta and the Liwa oasis, pulled from OpenStreetMap via Overpass and stored as true PostGIS `LINESTRING` geometry |
| **Routing** | A* over that real geometry (136k nodes, 97% connected), costed by travel time, with congestion feeding the edge weights. Every route reports how far each endpoint was snapped and warns if it lands more than 1.5 km from the address |
| **Border crossings** | Real posts on the Oman and Saudi frontiers, with the corridors that serve them |
| **Streets & place names** | ~17,500 named places — 9,000 buildings, 4,200 amenities, 2,300 settlements, 1,950 landmarks — across all seven emirates, English names first |
| **Geocoding** | Fuzzy search over every place and named street, reverse lookup from a coordinate (right-click the map), and "what's within 5 km" queries |
| **CCTV** | RTSP (RFC 2326) and ONVIF Profile S implemented at the wire level — real handshakes, real auth, real device discovery |
| **Infrastructure register** | Current UAE bridge and corridor projects, every figure carrying a published source URL |
| **Complaint NLP** | Rule-based classification, sentiment, location extraction, priority and routing — no GPU, genuinely usable at small-city volume |
| **Corridor design** | Detour analysis and gap detection against the real network, cross-checked against projects already funded |

Still mock (behind real interfaces, clearly marked): vehicle counts from
computer vision, road-damage detection, and LLM synthesis in the planner.
These need a GPU or a paid API and are wired for a one-method swap.

## The twelve modules

| # | Module | Page | Status |
|---|--------|------|--------|
| 1 | Smart Traffic Analysis (CV) | `/traffic` | Mock inference; real YOLO+ByteTrack interface |
| 2 | Road Damage Detection | `/maintenance` | Mock inference; real YOLO+SegFormer interface |
| 3 | Citizen Complaint Analysis (NLP) | `/complaints` | **Real** |
| 4 | Smart Traffic Prediction | `/traffic` | **Real** seasonal baseline; TFT/LSTM interface |
| 5 | AI City Planner (RAG) | `/planner` | **Real** grounded retrieval; LLM synthesis is the swap point |
| 6 | Digital Twin Dashboard | `/` | **Real** |
| 7 | Emergency Routing & Dispatch | `/dispatch` | **Real** — A* over the UAE network |
| 8 | Government Analytics / KPIs | `/` | **Real** |
| 9 | CCTV Camera Network | `/cameras` | **Real** RTSP/ONVIF client |
| 10 | UAE Road Network & Borders | `/network` | **Real** OSM ingestion |
| 11 | Infrastructure & Bridges | `/infrastructure` | **Real** sourced register |
| 12 | New Route Design | `/route-design` | **Real** corridor analysis |

## Running it

```bash
docker compose up -d --build
```

- Frontend: <http://localhost:3001>
- API docs: <http://localhost:8001/docs>

Ports are 3001/8001 rather than 3000/8000 to avoid colliding with other local
projects. Postgres/PostGIS is on 5432, Redis on 6379.

### First-run setup (three clicks)

The stack starts empty. Populate it from the UI:

1. **`/network`** → **INGEST NETWORK** — downloads the UAE highway network from
   OpenStreetMap. Takes 1–5 minutes; everything geographic depends on it.
2. **`/infrastructure`** → **LOAD REGISTER** — loads the UAE bridge/corridor projects.
3. **`/cameras`** → **SEED SITES** — creates the monitored junctions as camera sites.

Or from the API:

```bash
curl -X POST "http://localhost:8001/api/network/ingest?wait=true"
curl -X POST http://localhost:8001/api/infrastructure/seed
curl -X POST http://localhost:8001/api/cameras/seed-sites
```

MongoDB is in the architecture for raw CV frames and LLM logs but no code path
uses it yet, so it is excluded from the default stack. Start it with
`docker compose --profile full up -d`.

## Connecting real CCTV cameras

Module 9 is a working camera client, not a stub. It speaks RTSP over a raw
socket (`OPTIONS` → `DESCRIBE`, Basic and Digest auth, SDP parsing for codec
and resolution) and ONVIF Profile S over SOAP with WS-Security
`PasswordDigest`. Point it at an ONVIF camera's IP and it reads back the make,
model, firmware and the exact stream and snapshot URIs.

Three rules the implementation enforces:

- **Authorisation is required.** The platform refuses to contact a camera
  unless its record is marked `authorized`. Traffic CCTV in Dubai is operated
  by the **RTA**, and in Abu Dhabi by the **DMT / Integrated Transport Centre** —
  live feed access requires a data-sharing agreement with that authority.
  Private cameras need the site owner's written permission. Record the
  agreement in `authorization_ref` so access is auditable.
- **No passwords in the database.** `credential_ref` names an environment
  variable or secret-store entry, resolved at call time.
- **Analytics runs on the sub-stream.** A vehicle is just as detectable at
  640×480, and decoding a 4MP main stream per camera is what makes city-scale
  CV fall over.

Without a camera agreement you can still pull real Dubai government traffic
data from [Dubai Pulse](https://www.dubaipulse.gov.ae) — set
`SMARTCITY_DUBAI_PULSE_KEY` and `SMARTCITY_DUBAI_PULSE_SECRET`.

## Cross-border corridors

The network layer covers the UAE's land frontiers and the routes that serve
them: **Al Ghuwaifat** (Saudi Arabia, E11 — the freight gateway toward Qatar),
**Hatta / Al Wajajah** (Oman, E44), **Khatmat Malaha** (Oman, E99),
**Al Darah / Al Jeer** (Oman, northern E11 terminus into Musandam), and
**Mezyad** / **Hili** (Oman, via Al Ain). Links within 8 km of a crossing are
flagged as international corridors.

## Architecture

```
CCTV / ONVIF ─┐
OSM / Overpass ├─► Ingestion (Celery) ─► PostGIS ─► FastAPI ─► Next.js
Citizen reports ┘                          │
                                            ▼
                                  Redis (cache, broker, pub/sub)
                                            │
                                            ▼
                          AI services (CV, NLP, forecasting, RAG, routing)
```

See `docs/ARCHITECTURE.md`, `docs/MODULES.md` and `docs/ROADMAP.md`.

## Notes on estimates

Module 11 costs and capacities come from published project figures and each
row carries its `source_url`. Module 12 derives corridor costs from UAE unit
rates (AED 30m/km at grade to AED 520m/km tunnelled); those are
order-of-magnitude figures for option screening, not quantity-surveyed
estimates. Border-post coordinates in the curated fallback list are accurate to
roughly 1 km and are superseded by OSM data wherever it exists.

## Resume-safe description

> Built a production-style AI platform integrating computer vision, NLP,
> geospatial analytics, forecasting, and LLM-powered decision support.
> Implemented RTSP/ONVIF CCTV integration, OpenStreetMap network ingestion into
> PostGIS, A* travel-time routing over a national road network, and automated
> corridor feasibility analysis, using FastAPI, React/Next.js,
> PostgreSQL/PostGIS, Celery, Redis and Docker.

## Sessions, credentials and rate limits

- **Session cookie.** Login sets an `httpOnly`, `SameSite=Lax` cookie (`Secure`
  outside development); the browser never holds the token in JavaScript-readable
  storage. Cookie-authenticated writes must send `X-Requested-With` (CSRF guard);
  `Authorization: Bearer` still works for scripts. `POST /api/auth/logout` clears it.
- **Credentials.** Demo accounts share one password from `SMARTCITY_DEMO_PASSWORD`,
  held only as a salted scrypt hash. With `SMARTCITY_ENVIRONMENT` other than
  `development`, the API refuses to start on the default JWT secret/password.
- **Rate limits** (per client IP, Redis, fail-open): login 10/min, complaint
  submit 10/min, corridor analysis 20/min, place search/reverse 120/min → `429`
  with `Retry-After`.
