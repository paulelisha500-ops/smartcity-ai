"""
Smart Traffic Analysis (Module 1).

Production path: YOLOv8 (vehicle detection + classification) + ByteTrack
(multi-object tracking across frames) on RTSP camera streams or drone
footage. Each tracked vehicle contributes to counts, and speed is derived
from tracked position deltas over known camera calibration.

Mock path (below): deterministic, seeded pseudo-random generator so demo
data is stable and story-tellable (e.g. "Al Ittihad & 3rd St is consistently
the worst morning hotspot") rather than random noise on every request.
"""
import hashlib
import math
from datetime import datetime

from app.config import get_settings

settings = get_settings()


def _seeded_value(key: str, low: float, high: float) -> float:
    h = int(hashlib.sha256(key.encode()).hexdigest(), 16)
    frac = (h % 10_000) / 10_000
    return low + frac * (high - low)


class TrafficCVService:
    def analyze_intersection(self, intersection_id: int, intersection_name: str, ts: datetime | None = None):
        ts = ts or datetime.utcnow()

        if settings.model_mode == "production":
            # -----------------------------------------------------------
            # PRODUCTION EXTENSION POINT
            # frame = video_source.get_frame(intersection_id)
            # detections = yolo_model(frame)
            # tracks = byte_tracker.update(detections)
            # return self._aggregate(tracks)
            # -----------------------------------------------------------
            raise NotImplementedError(
                "production model_mode set but no CV backend configured. "
                "Implement analyze_intersection() with YOLO + ByteTrack here."
            )

        # --- mock mode: rush-hour-aware, per-intersection deterministic ---
        hour = ts.hour
        rush_multiplier = 1.6 if hour in (7, 8, 9, 17, 18, 19) else 1.0
        base_key = f"{intersection_id}-{intersection_name}-{ts.strftime('%Y-%m-%d-%H')}"

        vehicle_count = int(_seeded_value(base_key + "count", 40, 220) * rush_multiplier)
        avg_speed = max(5.0, _seeded_value(base_key + "speed", 15, 55) / rush_multiplier)
        queue_length = _seeded_value(base_key + "queue", 5, 120) * rush_multiplier
        lane_occupancy = min(100.0, _seeded_value(base_key + "occ", 20, 70) * rush_multiplier)

        # congestion score: high vehicle count + low speed + long queue -> high score
        congestion_score = min(
            100.0,
            (vehicle_count / 250 * 40) + ((60 - min(avg_speed, 60)) / 60 * 40) + (min(queue_length, 150) / 150 * 20),
        )

        return {
            "vehicle_count": vehicle_count,
            "avg_speed_kmh": round(avg_speed, 1),
            "congestion_score": round(congestion_score, 1),
            "queue_length_m": round(queue_length, 1),
            "lane_occupancy_pct": round(lane_occupancy, 1),
        }


traffic_cv_service = TrafficCVService()
