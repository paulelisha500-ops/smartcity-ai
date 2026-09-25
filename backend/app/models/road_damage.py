from sqlalchemy import Column, Integer, String, DateTime, Float
from geoalchemy2 import Geometry
from datetime import datetime

from app.database import Base


class RoadDamage(Base):
    __tablename__ = "road_damage"

    id = Column(Integer, primary_key=True)
    ts = Column(DateTime, default=datetime.utcnow)
    geom = Column(Geometry("POINT", srid=4326), nullable=False)
    damage_type = Column(String, nullable=False)   # pothole | crack | waterlogging | missing_sign
    severity = Column(Float, default=0.0)           # 0-1
    confidence = Column(Float, default=0.0)         # model confidence, 0-1
    image_ref = Column(String, nullable=True)
    source = Column(String, default="drone")        # drone | vehicle_cam | mock
    repaired = Column(Integer, default=0)
