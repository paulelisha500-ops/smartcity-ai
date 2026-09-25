# Rollout Roadmap: POC → Production

## Phase 0 — This repo (Weeks 0–2)
Architecture, data model, working NLP + Digital Twin + Analytics + Routing.
Mock CV/forecasting/RAG behind real interfaces. Runs on a laptop, no GPU.

## Phase 1 — Data onboarding (Weeks 2–6)
- Import real road network + intersections (city GIS shapefiles → PostGIS)
- Connect real 311/complaint intake (API or CSV batch) into `ComplaintNLPService`
- Historical traffic data backfill (if available) for forecasting baseline

## Phase 2 — CV pilot, 5 intersections (Weeks 6–12)
- Deploy YOLOv8 + ByteTrack on live/recorded feed from 5 pilot intersections
- Validate vehicle count / congestion score against manual counts
- Human-in-the-loop review queue before scores feed the dashboard

## Phase 3 — NLP at full complaint volume (Weeks 8–14, parallel)
- Replace rule-based classifier with a fine-tuned transformer once ≥2–3k
  labeled complaints exist (bootstrap labels from the rule-based system +
  human correction)
- Add routing-accuracy tracking (did it go to the right department?)

## Phase 4 — Forecasting validation (Weeks 12–18)
- Train LSTM/TFT on 90+ days of real sensor data
- Backtest against held-out weeks; report MAPE per intersection
- Only promote to "production" status once it beats the seasonal baseline

## Phase 5 — RAG planner on real data (Weeks 14–20)
- Ingest real GIS layers, capital project documents, historical incident
  reports into FAISS
- Wire LangGraph agent with tools: SQL query tool, spatial query tool,
  document retrieval tool
- Add citation/traceability requirement: every answer must cite the
  underlying data it used

## Phase 6 — Citywide rollout (Month 5+)
- Scale CV inference workers per intersection cluster
- Road damage detection via periodic drone/vehicle-mounted camera sweeps
- Mobile app GA release; alerts wired to real department SLAs
- Government Analytics dashboard becomes the KPI system of record

## Success metrics to report at each phase gate
- Congestion index accuracy vs. ground truth
- Complaint routing accuracy / resolution-time reduction
- Forecast MAPE vs. baseline
- Emergency route time savings vs. static routing
- Citizen adoption (mobile app reports/month)
