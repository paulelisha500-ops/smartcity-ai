"""
Named places — the gazetteer behind search, map labels and geocoding.

One row per named thing on the ground: a city, a district, a named building,
a hospital, a mall, a school. This is deliberately *named* features only.
OpenStreetMap holds several million building footprints for the UAE, the vast
majority of them unnamed outlines that add gigabytes and answer no question a
planner asks. A named gazetteer is what makes "where is Rashid Hospital"
resolvable, and it fits comfortably on a laptop.

Street names live on `road_link.name` and are searched from there, so a street
is not duplicated here.
"""
from datetime import datetime

from sqlalchemy import Column, Integer, String, DateTime, BigInteger, Float, Index
from geoalchemy2 import Geometry

from app.database import Base


class Place(Base):
    # Not "place": PostGIS ships the Tiger geocoder, whose `tiger.place` table
    # sits on the default search_path and silently shadows an unqualified
    # `place`, so queries resolve to the US census table instead of ours.
    __tablename__ = "gazetteer_place"

    id = Column(Integer, primary_key=True)
    osm_id = Column(BigInteger, index=True, nullable=True)
    osm_type = Column(String(8), nullable=True)          # node | way | relation

    name = Column(String, nullable=False, index=True)
    name_ar = Column(String, nullable=True)

    # What kind of thing this is, coarse then fine.
    category = Column(String, index=True, nullable=False)  # place | building | amenity | landmark | shop | tourism
    subcategory = Column(String, index=True, nullable=True)  # city | hospital | mall | mosque | hotel ...

    geom = Column(Geometry("POINT", srid=4326), nullable=False)

    emirate = Column(String, index=True, nullable=True)
    street = Column(String, nullable=True)
    postcode = Column(String, nullable=True)

    # Population for settlements — lets search rank Dubai above a Dubai café.
    population = Column(Integer, nullable=True)
    # Search weight, precomputed at ingest so ranking is a column read.
    importance = Column(Float, default=0.0, index=True)

    ingested_at = Column(DateTime, default=datetime.utcnow)


# Trigram index for fuzzy name search — created alongside the pg_trgm
# extension in init_db(). Declared here so it travels with the model.
Index(
    "ix_place_name_trgm",
    Place.name,
    postgresql_using="gin",
    postgresql_ops={"name": "gin_trgm_ops"},
)

# One row per OSM feature. Imports overlap by design — tiles share edges, a
# named hospital matches both the amenity and building queries, and a re-import
# can interleave with one still running — so uniqueness has to be enforced by
# the database rather than by hoping the ingest code dedupes perfectly.
Index("uq_place_osm", Place.osm_type, Place.osm_id, unique=True,
      postgresql_where=Place.osm_id.isnot(None))
