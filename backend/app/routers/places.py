"""
Gazetteer & geocoding API — named places, buildings, streets.
"""
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from geoalchemy2.shape import to_shape
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.services.ratelimit import rate_limit
from app.database import get_db, SessionLocal
from app.models.place import Place
from app.routers.auth import require_any, PLANNERS
from app.services import geocode, osm_places
from app.services.osm_places import EMIRATE_BBOX

router = APIRouter(prefix="/api/places", tags=["places"])

# Reads are public — the gazetteer backs the public digital twin's place
# labels and the citizen portal's location picker, so search/reverse/nearby
# have to work without a login. Only /ingest (external Overpass calls, DB
# writes) is gated to PLANNERS.


@router.get("/status")
def status(db: Session = Depends(get_db)):
    """How much of the gazetteer is loaded, and for which emirates."""
    total = db.query(func.count(Place.id)).scalar() or 0
    by_emirate = dict(
        db.query(Place.emirate, func.count(Place.id))
        .filter(Place.emirate.isnot(None))
        .group_by(Place.emirate).all()
    )
    by_category = dict(
        db.query(Place.category, func.count(Place.id))
        .group_by(Place.category).all()
    )
    return {
        "loaded": total > 0,
        "total_places": total,
        "by_emirate": by_emirate,
        "by_category": by_category,
        "emirates_available": list(EMIRATE_BBOX),
        "source": "OpenStreetMap via Overpass API",
    }


@router.get("/search", dependencies=[Depends(rate_limit("place-search", 120, 60))])
def search(
    q: str = Query(..., min_length=2, description="Place, building or street name"),
    limit: int = Query(12, le=50),
    emirate: str | None = None,
    category: str | None = Query(None, description="place | building | amenity | landmark | street"),
    lat: float | None = Query(None, description="Bias results toward this point"),
    lon: float | None = None,
    db: Session = Depends(get_db),
):
    """
    Fuzzy search across the gazetteer and every named street in the network.

    Tolerant of transliteration variants, so "Al Maktoum" and "Almaktoum" both
    resolve.
    """
    near = (lat, lon) if lat is not None and lon is not None else None
    return geocode.search(db, q, limit=limit, emirate=emirate, category=category, near=near)


@router.get("/reverse", dependencies=[Depends(rate_limit("place-reverse", 120, 60))])
def reverse(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180), radius_m: float = Query(1500, le=20000),
            db: Session = Depends(get_db)):
    """What is at this coordinate — nearest named place and street."""
    return geocode.reverse(db, lat, lon, radius_m=radius_m)


@router.get("/nearby")
def nearby(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180), category: str | None = None,
           subcategory: str | None = None, radius_km: float = Query(5.0, le=50),
           limit: int = Query(25, le=100), db: Session = Depends(get_db)):
    """Named features around a point, e.g. every hospital within 5 km."""
    return geocode.nearby(db, lat, lon, category=category,
                          subcategory=subcategory, radius_km=radius_km, limit=limit)


@router.get("")
def list_places(emirate: str | None = None, category: str | None = None,
                subcategory: str | None = None,
                min_importance: float = 0.0,
                limit: int = Query(500, le=5000),
                db: Session = Depends(get_db)):
    """Places for map rendering — importance-ordered so labels stay legible."""
    q = db.query(Place).filter(Place.importance >= min_importance)
    if emirate:
        q = q.filter(Place.emirate == emirate)
    if category:
        q = q.filter(Place.category.in_([c.strip() for c in category.split(",")]))
    if subcategory:
        q = q.filter(Place.subcategory == subcategory)

    out = []
    for p in q.order_by(Place.importance.desc()).limit(limit).all():
        point = to_shape(p.geom)
        out.append({
            "id": p.id, "name": p.name, "name_ar": p.name_ar,
            "category": p.category, "subcategory": p.subcategory,
            "emirate": p.emirate, "lat": point.y, "lon": point.x,
            "population": p.population, "importance": p.importance,
        })
    return out


def _run_places_ingest(emirate: str | None, include_buildings: bool):
    db = SessionLocal()
    try:
        osm_places.ingest_places(db, emirate=emirate, include_buildings=include_buildings)
    finally:
        db.close()


@router.post("/ingest")
def ingest(background: BackgroundTasks,
           emirate: str | None = Query(None, description="One emirate, or all if omitted"),
           include_buildings: bool = True,
           wait: bool = Query(False, description="Run inline instead of in the background"),
           db: Session = Depends(get_db),
           _user=Depends(require_any(*PLANNERS))):
    """
    Import named places, buildings and amenities from OpenStreetMap.

    Only *named* features are imported — the UAE has millions of unnamed
    building outlines that would take hours to fetch and answer no question.
    """
    if emirate and emirate not in EMIRATE_BBOX:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown emirate '{emirate}'. One of: {list(EMIRATE_BBOX)}",
        )

    if wait:
        try:
            return osm_places.ingest_places(db, emirate=emirate,
                                            include_buildings=include_buildings)
        except Exception as exc:
            raise HTTPException(status_code=503, detail=f"OSM import failed: {exc}")

    background.add_task(_run_places_ingest, emirate, include_buildings)
    return {
        "status": "import started",
        "scope": emirate or "all seven emirates",
        "poll": "/api/places/status",
    }
