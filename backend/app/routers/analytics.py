from datetime import datetime, timedelta
from statistics import mean

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.complaint import Complaint
from app.models.traffic import TrafficReading
from app.routers.traffic import live_traffic
from app.routers.road_damage import scan_all_segments

router = APIRouter(prefix="/api/analytics", tags=["analytics"])


@router.get("/kpis")
def government_kpis(db: Session = Depends(get_db)):
    """
    The KPI set a city agency would put on a monthly report:
    average travel time proxy, congestion index, complaint resolution time,
    road quality score, public satisfaction proxy.
    """
    traffic = live_traffic()
    congestion_index = round(mean(t["congestion_score"] for t in traffic), 1) if traffic else 0
    avg_speed = round(mean(t["avg_speed_kmh"] for t in traffic), 1) if traffic else 0

    damage = scan_all_segments()
    road_quality_score = round(100 - mean([d["severity"] * 100 for d in damage], ), 1) if damage else 100.0

    complaints = db.query(Complaint).all()
    resolved = [c for c in complaints if c.status == "resolved"]
    resolution_rate = round(len(resolved) / len(complaints) * 100, 1) if complaints else 0.0

    negative = [c for c in complaints if c.sentiment == "negative"]
    satisfaction_proxy = round(100 - (len(negative) / len(complaints) * 100), 1) if complaints else 100.0

    return {
        "congestion_index": congestion_index,
        "avg_speed_kmh": avg_speed,
        "road_quality_score": road_quality_score,
        "complaint_count": len(complaints),
        "complaint_resolution_rate_pct": resolution_rate,
        "public_satisfaction_proxy_pct": satisfaction_proxy,
    }


@router.get("/history/congestion")
def congestion_history(
    hours: int = Query(24, ge=1, le=24 * 30, description="How far back to look"),
    intersection_id: int | None = Query(None, description="One intersection, or citywide if omitted"),
    db: Session = Depends(get_db),
):
    """
    Hourly-bucketed congestion and speed trend from stored snapshots.

    Backed by `traffic_reading`, filled by the `snapshot_traffic_readings`
    Celery task every 15 minutes — this reflects what was actually recorded,
    not a live recomputation, so a fresh deployment with no history yet
    returns an empty list rather than fabricating one.
    """
    since = datetime.utcnow() - timedelta(hours=hours)
    bucket = func.date_trunc("hour", TrafficReading.ts)

    query = (
        db.query(
            bucket.label("hour"),
            func.avg(TrafficReading.congestion_score).label("avg_congestion"),
            func.avg(TrafficReading.avg_speed_kmh).label("avg_speed"),
            func.count(TrafficReading.id).label("samples"),
        )
        .filter(TrafficReading.ts >= since)
    )
    if intersection_id is not None:
        query = query.filter(TrafficReading.intersection_id == intersection_id)

    rows = query.group_by(bucket).order_by(bucket).all()
    return [
        {
            "hour": r.hour.isoformat(),
            "avg_congestion_score": round(r.avg_congestion, 1),
            "avg_speed_kmh": round(r.avg_speed, 1),
            "samples": r.samples,
        }
        for r in rows
    ]


@router.get("/history/complaints")
def complaint_history(
    days: int = Query(30, ge=1, le=365),
    db: Session = Depends(get_db),
):
    """
    Daily complaint volume trend, split by priority and by resolution.

    Aggregate counts only — no complaint text — so this is public like the
    rest of the KPI surface: it answers "is the queue growing or shrinking"
    without exposing what any individual citizen wrote.
    """
    since = datetime.utcnow() - timedelta(days=days)
    bucket = func.date_trunc("day", Complaint.ts)

    rows = (
        db.query(
            bucket.label("day"),
            func.count(Complaint.id).label("total"),
            func.count(Complaint.id).filter(Complaint.priority.in_(("critical", "high"))).label("high_priority"),
            func.count(Complaint.id).filter(Complaint.status == "resolved").label("resolved"),
        )
        .filter(Complaint.ts >= since)
        .group_by(bucket)
        .order_by(bucket)
        .all()
    )
    return [
        {
            "day": r.day.date().isoformat(),
            "total": r.total,
            "high_priority": r.high_priority,
            "resolved": r.resolved,
        }
        for r in rows
    ]
