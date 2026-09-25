from sqlalchemy import Column, Integer, String, DateTime, Text, Float
from geoalchemy2 import Geometry
from datetime import datetime

from app.database import Base


class Complaint(Base):
    __tablename__ = "complaint"

    id = Column(Integer, primary_key=True)
    ts = Column(DateTime, default=datetime.utcnow)
    text = Column(Text, nullable=False)
    geom = Column(Geometry("POINT", srid=4326), nullable=True)  # extracted/geocoded
    raw_location_text = Column(String, nullable=True)

    category = Column(String, nullable=True)      # pothole | signal | flooding | signage | other
    sentiment = Column(String, nullable=True)      # negative | neutral | positive
    sentiment_score = Column(Float, nullable=True)  # -1..1
    priority = Column(String, nullable=True)        # low | medium | high | critical
    priority_score = Column(Float, nullable=True)   # 0..1

    department = Column(String, nullable=True)      # roads | traffic_signals | drainage | signage
    status = Column(String, default="submitted")    # submitted | routed | in_progress | resolved
    photo_ref = Column(String, nullable=True)
    reporter_id = Column(String, nullable=True)
