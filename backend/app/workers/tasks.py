from app.workers.celery_app import celery_app
from app.services.road_damage_cv import road_damage_cv_service
from app.services.complaint_nlp import complaint_nlp_service


@celery_app.task(name="app.workers.tasks.process_cctv_frame")
def process_cctv_frame(intersection_id: int, frame_ref: str):
    """
    Production: pulls a frame from object storage (S3), runs YOLO+ByteTrack,
    writes a TrafficReading row, and publishes the result to Redis so
    /ws/live can broadcast it immediately. Kept off the request path since
    CV inference is too slow to run synchronously per-request.
    """
    # placeholder body — see traffic_cv.py for the interface this will call
    return {"intersection_id": intersection_id, "frame_ref": frame_ref, "status": "queued"}


@celery_app.task(name="app.workers.tasks.scan_all_road_segments")
def scan_all_road_segments():
    """Nightly (or on new-imagery-upload) sweep across all segments."""
    from app.routers.road_damage import _SEGMENTS  # local import avoids circular import at module load

    results = []
    for seg in _SEGMENTS:
        detections = road_damage_cv_service.scan_segment(seg["id"], seg["name"])
        results.extend(detections)
    return {"segments_scanned": len(_SEGMENTS), "detections_found": len(results)}


@celery_app.task(name="app.workers.tasks.classify_complaint_async")
def classify_complaint_async(complaint_text: str):
    """
    Used when complaints arrive via a batch channel (e.g. CSV import from a
    legacy 311 system) rather than the live API — same NLP service, just
    invoked off the request path.
    """
    analysis = complaint_nlp_service.analyze(complaint_text)
    return analysis.model_dump()


def _ensure_intersections_seeded(db) -> None:
    """
    Populate the `intersection` table from the mock intersection dataset.

    `TrafficReading.intersection_id` is a foreign key into `intersection`,
    but nothing had ever populated that table — the live/hotspots endpoints
    read straight from the JSON file and never touched the ORM model. Persist
    a TrafficReading against an empty `intersection` table and it fails on
    the FK constraint. Idempotent (checked once per run, upserts only what's
    missing), so it's cheap to call from every scheduled snapshot rather than
    needing a separate migration step.
    """
    import json
    from pathlib import Path
    from app.models.traffic import Intersection

    existing = {row[0] for row in db.query(Intersection.id).all()}
    path = Path(__file__).parent.parent / "data" / "mock_intersections.json"
    for spot in json.loads(path.read_text()):
        if spot["id"] in existing:
            continue
        db.add(Intersection(
            id=spot["id"], name=spot["name"],
            geom=f"SRID=4326;POINT({spot['lon']} {spot['lat']})",
            has_signal=1 if spot.get("has_signal") else 0,
        ))
    db.commit()


@celery_app.task(name="app.workers.tasks.snapshot_traffic_readings")
def snapshot_traffic_readings():
    """
    Persist the current (mock) reading for every intersection into
    `traffic_reading`, on a schedule (every 15 minutes — see celery_app.py).

    Nothing wrote to this table before: `GET /api/traffic/live` computes a
    reading on the fly from the seeded pseudo-random model and returns it
    without ever storing it, so there was no history to chart. Because that
    model is deterministic in (intersection, hour) — not literally random —
    snapshots taken over time reconstruct a believable diurnal pattern (rush
    hour peaks, quiet nights) rather than noise, which is what makes a trend
    chart over this data worth showing at all.
    """
    import json
    from datetime import datetime
    from pathlib import Path
    from app.database import SessionLocal
    from app.models.traffic import TrafficReading
    from app.services.traffic_cv import traffic_cv_service

    db = SessionLocal()
    try:
        _ensure_intersections_seeded(db)

        path = Path(__file__).parent.parent / "data" / "mock_intersections.json"
        spots = json.loads(path.read_text())
        now = datetime.utcnow()

        for spot in spots:
            result = traffic_cv_service.analyze_intersection(spot["id"], spot["name"], now)
            db.add(TrafficReading(
                intersection_id=spot["id"], ts=now,
                vehicle_count=result["vehicle_count"],
                avg_speed_kmh=result["avg_speed_kmh"],
                congestion_score=result["congestion_score"],
                queue_length_m=result["queue_length_m"],
                lane_occupancy_pct=result["lane_occupancy_pct"],
                source="mock",
            ))
        db.commit()
        return {"snapshotted": len(spots), "ts": now.isoformat()}
    finally:
        db.close()


@celery_app.task(name="app.workers.tasks.camera_health_sweep")
def camera_health_sweep():
    """
    Scheduled fleet health check (every 10 minutes — see celery_app.py).

    Opens its own DB session rather than reusing a request-scoped one, the
    same pattern the network/places background ingests use: a Celery worker
    process has no request to piggyback a session off. Calls the service
    function directly rather than the HTTP endpoint, since a scheduled worker
    is trusted service code — routing it through the auth-gated API would mean
    minting and rotating a service token for no benefit.
    """
    from app.database import SessionLocal
    from app.services.camera_link import sweep_fleet

    db = SessionLocal()
    try:
        return sweep_fleet(db, limit=200)
    finally:
        db.close()
