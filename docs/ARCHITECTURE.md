# Architecture

## High-level flow

```
CCTV / Drone feeds ─┐
Road inspection ──── ├─► Ingestion (Celery workers) ─► PostGIS / Mongo ─► FastAPI ─► Frontend / Mobile
Citizen reports ────┘                                        │
                                                               ▼
                                                     Redis (cache, pub/sub, WS)
                                                               │
                                                               ▼
                                          AI Services (CV, NLP, Forecasting, RAG)
```

## Why these datastores

- **PostgreSQL + PostGIS** — the system of record for anything with a location:
  road segments, intersections, incidents, complaints, sensor readings. PostGIS
  gives us spatial joins ("complaints within 200m of this intersection") and
  spatial indexes (GiST) that a plain relational DB can't do efficiently.
- **MongoDB** — flexible, semi-structured data: raw model outputs, CV detection
  frames/metadata, LLM conversation logs — data whose shape changes as models
  evolve, where a rigid schema would slow iteration.
- **Redis** — hot cache for dashboard tiles/KPIs, Celery broker, and pub/sub for
  WebSocket live updates (e.g., pushing a new congestion score to every open
  dashboard without polling).

## Service boundaries

Each AI module is a **service class** with a single public method (`analyze`,
`predict`, `classify`, `route`) that takes typed input and returns a typed
result. Routers never call models directly — they call the service, and the
service decides whether to run the mock path or the real model path based on
config (`SMARTCITY_MODEL_MODE=mock|production`). This means:

1. The POC runs everywhere (no GPU/API key required).
2. Swapping in a trained YOLO checkpoint or a hosted LLM is a config change and
   an implementation of one method, not a rewrite.
3. Every service is independently testable and independently scalable (CV
   inference can run on GPU workers, NLP on CPU workers, without touching the
   API layer).

## Real-time updates

Traffic officers and planners need live state, not just request/response. The
`/ws/live` WebSocket channel pushes:
- Congestion score updates per intersection (every 30s in mock mode, per-frame
  in production CV mode)
- New high-priority complaints as they're classified
- Emergency route changes

## Auth & roles

Five roles (Admin, Traffic Officer, City Planner, Maintenance Department,
Public User) are modeled as a single `role` claim on the JWT. Route-level
dependencies (`require_role(...)`) gate access; this is intentionally simple
for the POC and maps directly onto a production RBAC/SSO integration (e.g.
government SSO via SAML) later.

## Geospatial data model (simplified)

```
road_segment(id, geom LINESTRING, name, lanes, speed_limit, condition_score)
intersection(id, geom POINT, name)
traffic_reading(id, intersection_id, ts, vehicle_count, avg_speed, congestion_score, queue_length)
incident(id, geom POINT, type, severity, ts, source)
complaint(id, geom POINT, ts, text, category, sentiment, priority, status, department)
road_damage(id, geom POINT, ts, damage_type, severity, image_ref)
```

## Extension points (production upgrade path)

| Service | Mock implementation | Production swap-in |
|---|---|---|
| `TrafficCVService` | Deterministic pseudo-random counts seeded by intersection+time | YOLOv8 + ByteTrack on RTSP/video input, GPU inference workers |
| `RoadDamageService` | Heuristic severity from a seeded distribution | YOLO detection + SegFormer segmentation on drone/vehicle imagery |
| `ComplaintNLPService` | Rule-based classifier + keyword sentiment + regex/gazetteer location extraction | Fine-tuned transformer classifier + sentence-transformer embeddings + NER model |
| `ForecastingService` | Seasonal moving average + weekday/hour profile | LSTM / Temporal Fusion Transformer trained on historical sensor data |
| `RAGPlannerService` | In-memory TF-IDF-style retrieval over structured city facts | LangChain/LangGraph agent + FAISS vector store over GIS docs, policy PDFs, historical reports, live DB queries as tools |
| `EmergencyRoutingService` | Dijkstra over static road graph weights | Same graph, edge weights updated live from `TrafficCVService` output |
