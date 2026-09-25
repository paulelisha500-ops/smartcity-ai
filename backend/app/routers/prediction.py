from fastapi import APIRouter

from app.services.forecasting import forecasting_service

router = APIRouter(prefix="/api/prediction", tags=["prediction"])


@router.get("/intersection/{intersection_id}")
def forecast_intersection(intersection_id: int, horizon_hours: int = 24):
    """Answers: 'forecast tomorrow's congestion / rush-hour hotspots.'"""
    forecast = forecasting_service.forecast_intersection(intersection_id, historical_readings=[], horizon_hours=horizon_hours)
    return {"intersection_id": intersection_id, "horizon_hours": horizon_hours, "forecast": forecast}


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
