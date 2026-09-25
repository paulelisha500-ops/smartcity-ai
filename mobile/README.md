# Mobile App (Flutter) — Scope

Phase 2 of the rollout (see `docs/ROADMAP.md`). Not built out in this POC pass
because the highest-value thing to prove first is the backend/AI architecture
and the planner/analyst-facing dashboard. Scope for when this is built:

## Citizen-facing screens
- **Report an issue**: photo capture, auto GPS tag, free-text description →
  posts to `POST /api/complaints` (same endpoint the web form uses)
- **Report traffic**: quick "heavy traffic here" tap, geolocated
- **My reports**: list + status tracking, polling `GET /api/complaints/{id}`
- **Alerts**: push notifications for road closures/maintenance near saved
  locations (subscribes to a topic derived from `/ws/live`)

## Tech
- Flutter + Riverpod or Bloc for state
- `geolocator` + `image_picker` packages for the report flow
- Firebase Cloud Messaging (or a self-hosted alternative) for push alerts

## Why it shares the backend contract
The mobile app is a second client of the exact same `/api/complaints` and
`/api/traffic` endpoints the web dashboard uses — no separate mobile API.
This is why `ComplaintIn`/`ComplaintOut` schemas in the backend are already
mobile-shaped (photo_ref, lat/lon as plain floats, no web-only fields).
