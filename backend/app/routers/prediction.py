import logging
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.traffic import TrafficReading
from app.services.forecasting import forecasting_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/prediction", tags=["prediction"])

# How far back the seasonal baseline looks: two weeks gives every hour of the
# day fourteen samples without reaching into a different season.
HISTORY_DAYS = 14


@router.get("/intersection/{intersection_id}")
def forecast_intersection(
    intersection_id: int,
    horizon_hours: int = Query(24, ge=1, le=168),
    db: Session = Depends(get_db),
):
    """
    Answers: 'forecast tomorrow's congestion / rush-hour hotspots.'

    The baseline is built from the readings actually stored for this junction.
    It used to be called with no history at all, so every forecast came from
    the fixed fallback profile and ignored what had been recorded. The fallback
    remains for a junction with nothing stored yet (or an unreachable
    database), and `basis` says which one produced the answer.
    """
    history: list[dict] = []
    try:
        rows = (
            db.query(TrafficReading.ts, TrafficReading.congestion_score)
            .filter(TrafficReading.intersection_id == intersection_id)
            .filter(TrafficReading.ts >= datetime.utcnow() - timedelta(days=HISTORY_DAYS))
            .all()
        )
        history = [{"ts": ts, "congestion_score": score} for ts, score in rows if score is not None]
    except SQLAlchemyError:
        db.rollback()
        logger.warning("forecast: could not read history for intersection %s", intersection_id, exc_info=True)

    forecast = forecasting_service.forecast_intersection(
        intersection_id, historical_readings=history, horizon_hours=horizon_hours
    )
    return {
        "intersection_id": intersection_id,
        "horizon_hours": horizon_hours,
        "forecast": forecast,
        "basis": "history" if history else "typical_pattern",
        "history_points": len(history),
    }


@router.get("/event-impact")
def event_impact(baseline_congestion: float = 55.0, expected_attendance: int = 5000):
    """
    Rough event-impact estimator: attendance -> extra vehicle trips -> congestion delta.
    A production version ties this to historical events of similar size/venue.
    """
    extra_trips = expected_attendance * 0.35  # assume ~35% arrive by car
    congestion_delta = min(40.0, extra_trips / 500)  # simple saturating relationship
    return {
        "baseline_congestion_score": baseline_congestion,
        "expected_attendance": expected_attendance,
        "estimated_extra_vehicle_trips": int(extra_trips),
        "estimated_congestion_increase": round(congestion_delta, 1),
        "projected_congestion_score": round(min(100.0, baseline_congestion + congestion_delta), 1),
    }
