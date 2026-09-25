# Modules → API Endpoints

| Module | Endpoint(s) | Frontend page |
|---|---|---|
| 1. Smart Traffic Analysis | `GET /api/traffic/intersections`, `GET /api/traffic/live`, `GET /api/traffic/hotspots` | `/traffic`, `/` |
| 2. Road Damage Detection | `GET /api/road-damage/scan`, `GET /api/road-damage/priority` | `/maintenance` |
| 3. Citizen Complaint Analysis | `POST /api/complaints`, `GET /api/complaints`, `GET /api/complaints/{id}`, `PATCH /api/complaints/{id}/status`, `GET /api/complaints/analytics/summary` | `/complaints` |
| 4. Smart Traffic Prediction | `GET /api/prediction/intersection/{id}`, `GET /api/prediction/event-impact` | `/traffic` |
| 5. AI City Planner (LLM+RAG) | `POST /api/planner/ask` | `/planner` |
| 6. Digital Twin Dashboard | `GET /api/digital-twin/layers` | `/` |
| 7. Emergency Routing | `POST /api/emergency/route-geo`, `GET /api/emergency/nearest-facility`, `GET /api/emergency/facilities`, `POST /api/emergency/route` (legacy) | `/dispatch` |
| 8. Government Analytics | `GET /api/analytics/kpis` | `/` (KPI row) |
| 9. CCTV Camera Network | `GET/POST /api/cameras`, `POST /api/cameras/{id}/test`, `POST /api/cameras/health-sweep`, `POST /api/cameras/onboard`, `POST /api/cameras/seed-sites`, `GET /api/cameras/summary`, `GET /api/cameras/integration-guide` | `/cameras` |
| 10. UAE Road Network & Borders | `POST /api/network/ingest`, `GET /api/network/status`, `GET /api/network/roads`, `GET /api/network/border-crossings`, `GET /api/network/corridors`, `GET /api/network/graph` | `/network` |
| 11. Infrastructure & Bridges | `GET /api/infrastructure/projects`, `GET /api/infrastructure/bridges`, `GET /api/infrastructure/summary`, `POST /api/infrastructure/seed`, `POST /api/infrastructure/projects` | `/infrastructure` |
| 12. New Route Design | `POST /api/route-design/analyze`, `GET /api/route-design/presets`, `GET /api/route-design/proposals` | `/route-design` |

Auth: `POST /api/auth/login` issues a JWT with a `role` claim
(`admin`, `traffic_officer`, `city_planner`, `maintenance_department`,
`public_user`). Demo credentials are in `backend/app/routers/auth.py`.

WebSocket: `ws://localhost:8001/ws/live` pushes periodic congestion updates.

---

## Module 9 — CCTV Camera Network

Speaks two real protocols, implemented at the wire level so the container
needs neither ffmpeg nor OpenCV:

- **RTSP** (RFC 2326) over a raw TCP socket. Runs a genuine `OPTIONS` →
  `DESCRIBE` handshake, answers Basic and Digest auth challenges, and parses
  the SDP for codec and resolution. Stopping at `DESCRIBE` proves reachability,
  credentials and stream path without pulling video — cheap enough to health
  check thousands of cameras on a schedule.
- **ONVIF Profile S** over SOAP, with WS-Security `PasswordDigest`. Given only
  an IP it returns make/model/firmware and the exact stream and snapshot URIs.

**Governance.** The platform refuses to contact a camera unless its record is
marked `authorized`. Connecting to cameras you do not operate — including
government traffic CCTV — requires a data-sharing agreement with the operating
authority (Dubai: RTA; Abu Dhabi: DMT / Integrated Transport Centre). Record
the agreement in `authorization_ref`.

**Secrets.** Passwords are never stored in the database. `credential_ref` names
an environment variable / secret-store entry that the connector resolves at
call time.

**Performance.** Register a `substream_path`; CV analytics runs on the
low-resolution sub-stream because a vehicle is just as detectable at 640×480,
and decoding 4MP per camera is what makes city-scale CV fall over.

**Open data alternative.** Without a camera agreement, real Dubai government
traffic data is available from [Dubai Pulse](https://www.dubaipulse.gov.ae)
(OAuth `client_credentials`; set `SMARTCITY_DUBAI_PULSE_KEY` / `_SECRET`).

## Module 10 — UAE Road Network & Borders

`POST /api/network/ingest` pulls every motorway, trunk, primary and secondary
road in the UAE from OpenStreetMap via the Overpass API and stores true
`LINESTRING` geometry in PostGIS. Border posts come from OSM
`barrier=border_control`, backed by a curated list of the major named
crossings. Links within 8 km of a crossing are flagged `is_international`.

Known crossings covered: **Al Ghuwaifat** (Saudi Arabia, E11), **Hatta / Al
Wajajah** (Oman, E44), **Khatmat Malaha** (Oman, E99), **Al Darah / Al Jeer**
(Oman, E11 north terminus), **Mezyad** and **Hili** (Oman, via Al Ain).

### Streets, place names and geocoding

| Endpoint | Purpose |
|---|---|
| `POST /api/network/ingest-streets?emirate=…` | Add tertiary, residential, unclassified and living streets for one emirate |
| `GET /api/network/streets` | Distinct named streets, grouped across OSM way fragments |
| `POST /api/places/ingest?emirate=…` | Import named settlements, buildings, amenities and landmarks |
| `GET /api/places/search?q=…` | Fuzzy search across places **and** every named street |
| `GET /api/places/reverse?lat=…&lon=…` | Nearest named place and street to a coordinate |
| `GET /api/places/nearby?lat=…&lon=…` | Named features within a radius, e.g. hospitals within 5 km |
| `GET /api/places/status` | Gazetteer counts by emirate and category |

Design decisions worth knowing:

- **Named features only.** OSM holds millions of unnamed building outlines for
  the UAE. They would take hours to fetch and answer no question a planner
  asks, so the gazetteer imports named buildings, amenities, landmarks and
  settlements (~17,500 across the seven emirates, including Al Ain and Hatta).
- **Emirate labels come from boxes, smallest first,** with extra boxes for the
  parts that fall outside each emirate's main rectangle — Al Ain (Abu Dhabi),
  Hatta (Dubai), and Khor Fakkan, Kalba and Al Madam (Sharjah). Buraimi (Oman)
  sits inside the Al Ain box and is labelled Abu Dhabi; municipality polygons
  are the proper fix.
- **Gap-fill re-fetches only the tiles that failed** (`gapfill_tiles`), judged
  by how many stored roads have their midpoint inside each tile — so a partial
  import is completed without repeating every request that already succeeded.
- **English names first.** OSM's plain `name` tag is usually Arabic in the
  UAE; `name:en` is preferred for display and the Arabic form is kept in
  `name_ar`, still searchable.
- **Fuzzy matching via `pg_trgm`,** so transliteration variants ("Al Maktoum",
  "Almaktoum") resolve to the same feature.
- **Relevance before prominence.** Ranking is text similarity plus phrase and
  exact-match bonuses; importance (population, category) is capped so it breaks
  ties but never outvotes the text — otherwise "Dubai Mall" returns the city.
- **One row per OSM feature,** enforced by a unique index with
  `ON CONFLICT DO NOTHING`, so imports are re-runnable and safe to overlap.
- **Adaptive tiling.** Request count scales with the emirate's area: Ajman is a
  single query, Abu Dhabi is 64 for named buildings. A fixed grid either
  wastes requests on small emirates or times out on large ones.
- **Routing stays on the arterial network.** Residential and service streets
  are stored, drawn and searchable, but not loaded into the in-memory routing
  graph (`ROUTING_CLASSES` in `road_graph.py`) — at full street density it
  would exceed the stack's memory for no gain in inter-city routing.

## Module 11 — Infrastructure & Bridges

A register of real UAE capital works. Every capacity, cost and schedule figure
carries a `source_url`, because the first question in a government review is
always where the number came from.

## Module 12 — New Route Design

Assesses whether a new corridor is justified:

1. Route A→B over the real network for today's distance and time.
2. Compare against the straight line — `detour_ratio` above ~1.45 means the
   network forces a significant detour.
3. Sample the ideal corridor and measure distance to the nearest road; a long
   unserved run is the physical gap (water/undeveloped land).
4. Cross-reference the M11 register so it never proposes what is already
   being built.
5. Score feasibility and cost it from published UAE unit rates.

Output is an option-screening estimate, not a design.
