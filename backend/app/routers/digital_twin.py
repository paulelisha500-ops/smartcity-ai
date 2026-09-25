from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.routers.traffic import live_traffic
from app.routers.road_damage import scan_all_segments
from app.models.complaint import Complaint

router = APIRouter(prefix="/api/digital-twin", tags=["digital-twin"])


@router.get("/layers")
def dashboard_layers(db: Session = Depends(get_db)):
    """
    Single call that hydrates the whole map: traffic heatmap points,
    road-damage points, and recent complaint points. Keeps the frontend
    to one request on load, then it subscribes to /ws/live for deltas.
    """
    traffic_points = live_traffic()
    damage_points = scan_all_segments()

    complaints = db.query(Complaint).order_by(Complaint.ts.desc()).limit(200).all()
    complaint_points = []
    for c in complaints:
        if c.geom is None:
            continue
        from geoalchemy2.shape import to_shape
        point = to_shape(c.geom)
        complaint_points.append({
            "id": c.id, "lat": point.y, "lon": point.x,
            "category": c.category, "priority": c.priority, "status": c.status,
        })

    return {
        "traffic": traffic_points,
        "road_damage": damage_points,
        "complaints": complaint_points,
    }
