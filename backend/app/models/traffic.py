from sqlalchemy import Column, Integer, String, Float, DateTime, ForeignKey
from geoalchemy2 import Geometry
from datetime import datetime

from app.database import Base


class RoadSegment(Base):
    __tablename__ = "road_segment"

    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    geom = Column(Geometry("LINESTRING", srid=4326), nullable=False)
    lanes = Column(Integer, default=2)
    speed_limit_kmh = Column(Integer, default=50)
    condition_score = Column(Float, default=100.0)  # 0-100, 100 = perfect


class Intersection(Base):
    __tablename__ = "intersection"

    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    geom = Column(Geometry("POINT", srid=4326), nullable=False)
    has_signal = Column(Integer, default=1)  # 1/0 (kept simple for POC)


class TrafficReading(Base):
    __tablename__ = "traffic_reading"

    id = Column(Integer, primary_key=True)
    intersection_id = Column(Integer, ForeignKey("intersection.id"), nullable=False)
    ts = Column(DateTime, default=datetime.utcnow)
    vehicle_count = Column(Integer, default=0)
    avg_speed_kmh = Column(Float, default=0.0)
    congestion_score = Column(Float, default=0.0)  # 0-100
    queue_length_m = Column(Float, default=0.0)
    lane_occupancy_pct = Column(Float, default=0.0)
    source = Column(String, default="cctv")  # cctv | drone | mock
