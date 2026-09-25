from pydantic import BaseModel
from datetime import datetime


class IntersectionOut(BaseModel):
    id: int
    name: str
    lat: float
    lon: float
    has_signal: bool


class TrafficReadingOut(BaseModel):
    intersection_id: int
    intersection_name: str
    ts: datetime
    vehicle_count: int
    avg_speed_kmh: float
    congestion_score: float
    queue_length_m: float
    lane_occupancy_pct: float

    class Config:
        from_attributes = True


class CongestionHotspot(BaseModel):
    intersection_id: int
    intersection_name: str
    lat: float
    lon: float
    congestion_score: float
    rank: int
