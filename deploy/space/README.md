---
title: SmartCity AI
emoji: 🏙️
colorFrom: blue
colorTo: green
sdk: static
pinned: true
short_description: Urban planning and traffic platform for UAE cities
---

# SmartCity AI

Intelligent urban planning and traffic management for the seven emirates —
twelve modules covering traffic analysis, citizen services, emergency dispatch
and long-range infrastructure planning, over the real UAE road network
(170,892 links, 50,056 km) and 17,540 named places from OpenStreetMap.

**Open the app:** <https://elisha622-smartcity-ai.static.hf.space>

Sign in from the welcome page: pick any role on the sign-in screen and the
form fills itself.

## How this edition runs

This Space is a static site — no server process. The console is the same
Next.js application as the self-hosted platform, with its API calls answered
in the browser:

- **Recorded** — the road network, gazetteer, project register, camera fleet
  and dispatch routes are the API's own output, published as data files.
- **Computed** — place search, reverse geocoding, complaint analysis, the
  planner, the traffic model and corridor design (A\* over a 135,882-node
  routing graph) are ports of the backend services running client-side.

Reports you file stay in your browser for the visit; nothing is stored
server-side. The full platform, with PostGIS, live ingestion and the
RTSP/ONVIF camera client, is in the source repository.

## Source

- Code: <https://github.com/paulelisha500-ops/smartcity-ai>
- This Space is built and published by GitHub Actions on every push to `main`.

Map data © OpenStreetMap contributors. Basemap tiles © Esri.
