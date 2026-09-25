"""
Road Damage Detection (Module 2).

Production path: YOLO for damage localization (pothole/crack/missing-sign
bounding boxes) + SegFormer for pixel-level segmentation of waterlogging
extent. Input is drone sweep imagery or vehicle-mounted dashcam footage,
tiled and run per-frame with GPS/geo tag propagated from flight/vehicle
telemetry.

Mock path: seeded synthetic detections against provided mock road segments,
useful for exercising the full pipeline (detection -> DB -> map layer ->
maintenance prioritization) without an imagery pipeline in place.
"""
import hashlib
from datetime import datetime

from app.config import get_settings

settings = get_settings()

DAMAGE_TYPES = ["pothole", "crack", "waterlogging", "missing_sign"]


def _seeded(key: str, low: float, high: float) -> float:
    h = int(hashlib.sha256(key.encode()).hexdigest(), 16)
    return low + (h % 10_000) / 10_000 * (high - low)


class RoadDamageCVService:
    def scan_segment(self, segment_id: int, segment_name: str):
        if settings.model_mode == "production":
            # -----------------------------------------------------------
            # PRODUCTION EXTENSION POINT
            # frames = imagery_source.get_frames(segment_id)
            # detections = yolo_damage_model(frames)
            # masks = segformer_model(frames)  # for waterlogging extent
            # return self._to_detections(detections, masks)
            # -----------------------------------------------------------
            raise NotImplementedError("Implement scan_segment() with YOLO + SegFormer here.")

        key_base = f"{segment_id}-{segment_name}"
        n_detections = int(_seeded(key_base + "n", 0, 4))
        detections = []
        for i in range(n_detections):
            k = f"{key_base}-{i}"
            damage_type = DAMAGE_TYPES[int(_seeded(k + "type", 0, len(DAMAGE_TYPES))) % len(DAMAGE_TYPES)]
            detections.append({
                "damage_type": damage_type,
                "severity": round(_seeded(k + "sev", 0.2, 0.95), 2),
                "confidence": round(_seeded(k + "conf", 0.6, 0.98), 2),
                "ts": datetime.utcnow().isoformat(),
            })
        return detections


road_damage_cv_service = RoadDamageCVService()
