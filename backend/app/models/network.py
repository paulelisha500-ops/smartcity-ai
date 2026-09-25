"""
M10 — the real UAE road network.

`RoadLink` rows are ingested from OpenStreetMap (via Overpass) and carry true
LINESTRING geometry in EPSG:4326, so routing, map rendering and spatial joins
all run against the actual road layout rather than a toy graph.

`BorderCrossing` rows mark where the UAE network connects to Oman and Saudi
Arabia — the international corridors the platform has to reason about for
freight routing and cross-border incident response.
"""
from datetime import datetime

from sqlalchemy import Column, Integer, String, Float, DateTime, Boolean, BigInteger
from geoalchemy2 import Geometry

from app.database import Base


class RoadLink(Base):
    """A single routable stretch of road, straight from OSM."""

    __tablename__ = "road_link"

    id = Column(Integer, primary_key=True)
    osm_id = Column(BigInteger, index=True, nullable=True)
    name = Column(String, nullable=True)
    name_ar = Column(String, nullable=True)
    ref = Column(String, index=True, nullable=True)   # E11, E311, D63 ...
    highway = Column(String, index=True, nullable=False)  # motorway|trunk|primary|...
    geom = Column(Geometry("LINESTRING", srid=4326), nullable=False)

    # Routing attributes
    length_m = Column(Float, default=0.0)
    lanes = Column(Integer, nullable=True)
    maxspeed_kmh = Column(Integer, nullable=True)
    oneway = Column(Boolean, default=False)
    bridge = Column(Boolean, default=False)
    tunnel = Column(Boolean, default=False)
    toll = Column(Boolean, default=False)             # Salik gates sit on these

    # Endpoint node ids from OSM — these are what stitch links into a graph.
    start_node = Column(BigInteger, index=True, nullable=True)
    end_node = Column(BigInteger, index=True, nullable=True)

    emirate = Column(String, index=True, nullable=True)
    condition_score = Column(Float, default=100.0)    # 0-100, from M2 damage data
    congestion_score = Column(Float, default=0.0)     # 0-100, live from M1
    is_international = Column(Boolean, default=False)  # part of a cross-border corridor

    ingested_at = Column(DateTime, default=datetime.utcnow)


class BorderCrossing(Base):
    """Where the UAE road network meets a neighbouring country."""

    __tablename__ = "border_crossing"

    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    geom = Column(Geometry("POINT", srid=4326), nullable=False)
    country_a = Column(String, default="United Arab Emirates")
    country_b = Column(String, nullable=False)        # Oman | Saudi Arabia
    emirate = Column(String, nullable=True)
    road_ref = Column(String, nullable=True)          # E11, E44, E102 ...
    crossing_type = Column(String, default="road")    # road | freight | pedestrian
    open_24h = Column(Boolean, default=True)
    freight_enabled = Column(Boolean, default=True)
    notes = Column(String, nullable=True)
    source = Column(String, nullable=True)
