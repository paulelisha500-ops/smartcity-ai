"""
M9 — CCTV camera registry.

One row per physical camera the platform is authorised to talk to. The row
holds everything needed to *reach* the camera (host, protocol, stream path)
and everything needed to *place* it on the digital twin (geometry, the road or
intersection it watches), but never a plaintext password: `credential_ref`
names an entry in the deployment's secret store (env var, Vault path, AWS
Secrets Manager ARN) which the connector resolves at call time.
"""
from datetime import datetime

from sqlalchemy import Column, Integer, String, Float, DateTime, Boolean, Text
from geoalchemy2 import Geometry

from app.database import Base


class Camera(Base):
    __tablename__ = "camera"

    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    geom = Column(Geometry("POINT", srid=4326), nullable=True)

    # Where it sits in the city
    emirate = Column(String, nullable=True)        # Dubai | Abu Dhabi | Sharjah | ...
    road_ref = Column(String, nullable=True)       # E11, D63, ...
    intersection_id = Column(Integer, nullable=True)
    bearing_deg = Column(Float, nullable=True)     # direction the lens faces
    coverage_m = Column(Float, default=120.0)      # effective detection range

    # How we reach it
    protocol = Column(String, default="rtsp")      # rtsp | onvif | http_snapshot
    host = Column(String, nullable=False)
    port = Column(Integer, nullable=True)
    stream_path = Column(String, nullable=True)    # /Streaming/Channels/101
    substream_path = Column(String, nullable=True)  # low-res path used for CV
    snapshot_path = Column(String, nullable=True)  # /onvif-http/snapshot
    username = Column(String, nullable=True)
    credential_ref = Column(String, nullable=True)  # secret-store key, NOT a password

    # Governance — a camera is only polled when authorisation is on record.
    owner_org = Column(String, nullable=True)      # e.g. "Dubai RTA", "Private - Mall X"
    authorized = Column(Boolean, default=False)
    authorization_ref = Column(String, nullable=True)  # agreement / permit id

    # Live health, updated by the connector
    status = Column(String, default="unknown")     # online | offline | unauthorized | unknown
    last_seen = Column(DateTime, nullable=True)
    last_error = Column(Text, nullable=True)
    latency_ms = Column(Float, nullable=True)
    resolution = Column(String, nullable=True)     # discovered from SDP/ONVIF
    codec = Column(String, nullable=True)
    manufacturer = Column(String, nullable=True)
    model = Column(String, nullable=True)
    firmware = Column(String, nullable=True)

    enabled = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
