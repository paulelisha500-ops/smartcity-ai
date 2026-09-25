from celery import Celery

from app.config import get_settings

settings = get_settings()

celery_app = Celery(
    "smartcity",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=["app.workers.tasks"],
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    beat_schedule={
        # Periodic road-damage sweep across all segments (production: triggered
        # by new drone footage upload instead of a fixed schedule)
        "nightly-road-damage-scan": {
            "task": "app.workers.tasks.scan_all_road_segments",
            "schedule": 24 * 60 * 60.0,
        },
        # Camera fleet health. 10 minutes balances staleness against load: an
        # RTSP DESCRIBE/ONVIF probe per camera is a few hundred ms to ~6s
        # (camera_connect_timeout_s) each, so a fleet of a few hundred cameras
        # comfortably finishes well inside the interval.
        "camera-health-sweep": {
            "task": "app.workers.tasks.camera_health_sweep",
            "schedule": 10 * 60.0,
        },
        # Traffic history. 15 minutes gives ~96 points/day per intersection —
        # enough resolution to see rush-hour shape on an hourly trend chart
        # without the table growing unreasonably (20 intersections x 96/day
        # is a few thousand rows a week, trivial for Postgres).
        "traffic-snapshot": {
            "task": "app.workers.tasks.snapshot_traffic_readings",
            "schedule": 15 * 60.0,
        },
    },
)
