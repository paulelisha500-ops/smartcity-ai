from fastapi import APIRouter

from app.services.road_damage_cv import road_damage_cv_service

router = APIRouter(prefix="/api/road-damage", tags=["road-damage"])

# In production these come from PostGIS road_segment table.
_SEGMENTS = [
    {"id": 1, "name": "Al Ittihad Rd (Segment 1-4)", "lat": 25.4060, "lon": 55.4040},
    {"id": 2, "name": "Corniche Rd (Segment 2-1)", "lat": 25.4190, "lon": 55.4460},
    {"id": 3, "name": "Industrial Rd (Segment 5-2)", "lat": 25.3885, "lon": 55.4115},
    {"id": 4, "name": "School Zone Access Rd", "lat": 25.4115, "lon": 55.4368},
]


@router.get("/scan")
def scan_all_segments():
    """Runs damage detection across all known road segments — 'which roads need maintenance first?'"""
    results = []
    for seg in _SEGMENTS:
        detections = road_damage_cv_service.scan_segment(seg["id"], seg["name"])
        for d in detections:
            results.append({**seg, **d})
    return results


@router.get("/priority")
def maintenance_priority(limit: int = 10):
    """Ranks detections by severity*confidence — feeds the maintenance dept queue."""
    detections = scan_all_segments()
    ranked = sorted(detections, key=lambda d: d["severity"] * d["confidence"], reverse=True)
    return ranked[:limit]
