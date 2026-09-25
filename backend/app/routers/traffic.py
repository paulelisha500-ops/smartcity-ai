import json
from pathlib import Path
from datetime import datetime

from fastapi import APIRouter

from app.services.traffic_cv import traffic_cv_service

router = APIRouter(prefix="/api/traffic", tags=["traffic"])

_INTERSECTIONS_PATH = Path(__file__).parent.parent / "data" / "mock_intersections.json"
_INTERSECTIONS = json.loads(_INTERSECTIONS_PATH.read_text())


@router.get("/intersections")
def list_intersections():
    return _INTERSECTIONS


@router.get("/live")
def live_traffic():
    """Current readings for every intersection — powers the dashboard map layer."""
    now = datetime.utcnow()
    readings = []
    for i in _INTERSECTIONS:
        result = traffic_cv_service.analyze_intersection(i["id"], i["name"], now)
        readings.append({
            "intersection_id": i["id"],
            "intersection_name": i["name"],
            "lat": i["lat"],
            "lon": i["lon"],
            "ts": now.isoformat(),
            **result,
        })
    return readings


@router.get("/hotspots")
def congestion_hotspots(limit: int = 5):
    """Ranked list answering: 'which intersections cause the most congestion?'"""
    readings = live_traffic()
    ranked = sorted(readings, key=lambda r: r["congestion_score"], reverse=True)
    return [
        {
            "rank": idx + 1,
            "intersection_id": r["intersection_id"],
            "intersection_name": r["intersection_name"],
            "lat": r["lat"],
            "lon": r["lon"],
            "congestion_score": r["congestion_score"],
        }
        for idx, r in enumerate(ranked[:limit])
    ]
