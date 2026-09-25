"""
M10 — UAE road network, border crossings and international corridors.
"""
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from geoalchemy2 import Geometry
from sqlalchemy.orm import defer
from geoalchemy2.shape import to_shape
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db, SessionLocal
from app.models.network import RoadLink, BorderCrossing
from app.routers.auth import require_any, PLANNERS
from app.services import osm_network
from app.services.road_graph import graph_cache

router = APIRouter(prefix="/api/network", tags=["network"])

# Reads (status/roads/streets/border-crossings/corridors/graph) are public —
# this is the same road-network and border-post data any city GIS portal
# publishes. Only ingestion is gated: it calls the external Overpass API
# (a cost and an abuse vector) and writes to the database, so it's restricted
# to PLANNERS (admin, city_planner).


@router.get("/status")
def network_status(db: Session = Depends(get_db)):
    """Is the real network loaded, and how much of it?"""
    total = db.query(func.count(RoadLink.id)).scalar() or 0
    length_m = db.query(func.coalesce(func.sum(RoadLink.length_m), 0.0)).scalar() or 0.0
    crossings = db.query(func.count(BorderCrossing.id)).scalar() or 0

    by_class = dict(
        db.query(RoadLink.highway, func.count(RoadLink.id))
        .group_by(RoadLink.highway).all()
    )
    by_emirate = dict(
        db.query(RoadLink.emirate, func.count(RoadLink.id))
        .filter(RoadLink.emirate.isnot(None))
        .group_by(RoadLink.emirate).all()
    )

    return {
        "ingested": total > 0,
        "road_links": total,
        "network_km": round(length_m / 1000.0, 1),
        "border_crossings": crossings,
        "international_links": db.query(func.count(RoadLink.id))
                                 .filter(RoadLink.is_international == True).scalar() or 0,  # noqa: E712
        "by_class": by_class,
        "by_emirate": by_emirate,
        "source": "OpenStreetMap via Overpass API",
    }


def _run_ingest(classes: list[str] | None):
    """Background job — Overpass can take a minute for the whole country."""
    db = SessionLocal()
    try:
        osm_network.ingest_all(db, classes=classes)
        graph_cache.invalidate()
    finally:
        db.close()


@router.post("/ingest")
def ingest_network(background: BackgroundTasks,
                   classes: str | None = Query(
                       None,
                       description="Comma-separated OSM highway classes. "
                                   "Default: motorway,trunk,primary,secondary + links.",
                   ),
                   wait: bool = Query(False, description="Run inline instead of in the background"),
                   db: Session = Depends(get_db),
                   _user=Depends(require_any(*PLANNERS))):
    """
    Pull the real UAE highway network from OpenStreetMap into PostGIS.

    Runs in the background by default because a full-country Overpass query
    takes 30-90s; poll /api/network/status to watch it land.
    """
    class_list = [c.strip() for c in classes.split(",")] if classes else None

    if wait:
        try:
            result = osm_network.ingest_all(db, classes=class_list)
        except osm_network.OverpassError as exc:
            # Public Overpass instances are shared and often saturated. That is
            # an upstream availability problem, not a bad request, so say so
            # plainly instead of surfacing a 500.
            raise HTTPException(
                status_code=503,
                detail=(
                    f"OpenStreetMap (Overpass) is currently unavailable: {exc}. "
                    "This is a shared public service — retry in a few minutes, or "
                    "narrow the request with ?classes=motorway,trunk"
                ),
            )
        graph_cache.invalidate()
        return {"mode": "inline", **result}

    background.add_task(_run_ingest, class_list)
    return {
        "mode": "background",
        "status": "ingest started",
        "poll": "/api/network/status",
        "classes": class_list or osm_network.DEFAULT_HIGHWAY_CLASSES,
    }


def _run_street_ingest(emirate: str, classes: list[str], tiles: int):
    db = SessionLocal()
    try:
        from app.services.osm_places import EMIRATE_BBOX
        osm_network.ingest_road_network(
            db, bbox=EMIRATE_BBOX[emirate], classes=classes,
            replace=False, tiles=tiles,
        )
        graph_cache.invalidate()
    finally:
        db.close()


@router.post("/ingest-streets")
def ingest_streets(background: BackgroundTasks,
                   emirate: str = Query(..., description="Emirate to densify"),
                   tiles: int = Query(6, ge=2, le=10),
                   wait: bool = False,
                   db: Session = Depends(get_db),
                   _user=Depends(require_any(*PLANNERS))):
    """
    Import the full street network for one emirate — tertiary, residential,
    unclassified and living streets on top of the strategic network.

    Done per emirate and added rather than replaced, because these classes are
    an order of magnitude denser than the trunk network and a country-wide
    request is exactly what public Overpass instances refuse.
    """
    from app.services.osm_places import EMIRATE_BBOX

    if emirate not in EMIRATE_BBOX:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown emirate '{emirate}'. One of: {list(EMIRATE_BBOX)}",
        )

    street_classes = [
        "tertiary", "tertiary_link", "residential", "unclassified",
        "living_street", "service",
    ]

    if wait:
        try:
            result = osm_network.ingest_road_network(
                db, bbox=EMIRATE_BBOX[emirate], classes=street_classes,
                replace=False, tiles=tiles,
            )
        except osm_network.OverpassError as exc:
            raise HTTPException(status_code=503, detail=f"Overpass unavailable: {exc}")
        graph_cache.invalidate()
        return {"emirate": emirate, **result}

    background.add_task(_run_street_ingest, emirate, street_classes, tiles)
    return {
        "status": "street import started",
        "emirate": emirate,
        "classes": street_classes,
        "poll": "/api/network/status",
    }


@router.get("/streets")
def named_streets(emirate: str | None = None, q: str | None = None,
                  limit: int = Query(200, le=2000), db: Session = Depends(get_db)):
    """
    Distinct named streets. OSM splits one road into many ways, so this groups
    by name and reports the combined length rather than listing fragments.
    """
    query = (
        db.query(
            RoadLink.name,
            RoadLink.ref,
            RoadLink.emirate,
            func.count(RoadLink.id).label("segments"),
            func.sum(RoadLink.length_m).label("length_m"),
        )
        .filter(RoadLink.name.isnot(None))
    )
    if emirate:
        query = query.filter(RoadLink.emirate == emirate)
    if q:
        query = query.filter(RoadLink.name.ilike(f"%{q}%"))

    rows = (
        query.group_by(RoadLink.name, RoadLink.ref, RoadLink.emirate)
        .order_by(func.sum(RoadLink.length_m).desc())
        .limit(limit).all()
    )
    return [
        {"name": r.name, "ref": r.ref, "emirate": r.emirate,
         "segments": r.segments, "length_km": round((r.length_m or 0) / 1000, 2)}
        for r in rows
    ]


@router.get("/roads")
def roads(
    bbox: str | None = Query(None, description="south,west,north,east"),
    highway: str | None = Query(None, description="Filter by OSM highway class"),
    ref: str | None = Query(None, description="Filter by road ref, e.g. E11"),
    emirate: str | None = None,
    international_only: bool = False,
    limit: int = Query(1500, le=6000),
    db: Session = Depends(get_db),
):
    """
    GeoJSON-ish road geometry for the map.

    Capped by `limit` because the browser, not the database, is the bottleneck
    when drawing tens of thousands of polylines.
    """
    filters = []
    tolerance = 0.002  # ~200 m: fine for a country-wide view

    if highway:
        filters.append(RoadLink.highway.in_([h.strip() for h in highway.split(",")]))
    if ref:
        filters.append(RoadLink.ref == ref)
    if emirate:
        filters.append(RoadLink.emirate == emirate)
    if international_only:
        filters.append(RoadLink.is_international == True)  # noqa: E712
    if bbox:
        try:
            s_, w_, n_, e_ = [float(v) for v in bbox.split(",")]
        except ValueError:
            raise HTTPException(status_code=400, detail="bbox must be four numbers: south,west,north,east")
        if not (-90 <= s_ < n_ <= 90 and -180 <= w_ < e_ <= 180):
            # Silently ignoring a bad bbox returned the whole-country longest
            # roads as though they were the requested area.
            raise HTTPException(status_code=400, detail="bbox out of range or south/west not below north/east")
        # `&&` is the index's bounding-box overlap test. ST_Intersects re-tests
        # every candidate's exact geometry, which for ~30k long motorway
        # polylines cost ~1.8 s; for drawing a map the few links whose box
        # overlaps the viewport without touching it are harmless.
        filters.append(RoadLink.geom.op("&&")(func.ST_MakeEnvelope(w_, s_, e_, n_, 4326)))
        # Simplify to roughly one vertex per screen pixel across the viewport.
        tolerance = max(n_ - s_, e_ - w_) / 1500.0

    # Simplified in the database so the response carries only the vertices a
    # map can show — the full-resolution country view was ~1.5 MB of JSON.
    simplified = func.ST_SimplifyPreserveTopology(RoadLink.geom, tolerance, type_=Geometry("LINESTRING", srid=4326))
    # Choose the ids first (cheap: sort + limit), then simplify only those
    # rows. Simplifying inside the main select can run on every candidate.
    top = (
        db.query(RoadLink.id)
        .filter(*filters)
        .order_by(RoadLink.length_m.desc())
        .limit(limit)
        .subquery()
    )
    query = db.query(RoadLink, simplified.label("sg")).options(defer(RoadLink.geom)).join(top, RoadLink.id == top.c.id)

    # Longest first: at low zoom the motorways matter, not the slip roads.
    rows = query.order_by(RoadLink.length_m.desc()).all()

    out = []
    for link, sg in rows:
        try:
            line = to_shape(sg)
        except Exception:
            continue
        out.append({
            "id": link.id,
            "osm_id": link.osm_id,
            "name": link.name,
            "ref": link.ref,
            "highway": link.highway,
            "lanes": link.lanes,
            "maxspeed_kmh": link.maxspeed_kmh,
            "length_m": round(link.length_m or 0, 1),
            "bridge": bool(link.bridge),
            "tunnel": bool(link.tunnel),
            "toll": bool(link.toll),
            "emirate": link.emirate,
            "is_international": bool(link.is_international),
            "congestion_score": link.congestion_score,
            "geometry": [[lat, lon] for lon, lat in line.coords],
        })
    return out


@router.get("/border-crossings")
def border_crossings(country: str | None = None, db: Session = Depends(get_db)):
    """Every road crossing between the UAE and its neighbours."""
    query = db.query(BorderCrossing)
    if country:
        query = query.filter(BorderCrossing.country_b == country)

    out = []
    for c in query.all():
        point = to_shape(c.geom)
        out.append({
            "id": c.id,
            "name": c.name,
            "lat": point.y,
            "lon": point.x,
            "country_a": c.country_a,
            "country_b": c.country_b,
            "emirate": c.emirate,
            "road_ref": c.road_ref,
            "crossing_type": c.crossing_type,
            "open_24h": bool(c.open_24h),
            "freight_enabled": bool(c.freight_enabled),
            "notes": c.notes,
            "source": c.source,
        })
    return sorted(out, key=lambda c: (c["country_b"], c["name"]))


@router.get("/corridors")
def international_corridors(db: Session = Depends(get_db)):
    """
    The cross-border corridors, grouped by neighbouring country — what a
    freight or emergency planner needs when a route leaves the UAE.
    """
    crossings = db.query(BorderCrossing).all()
    grouped: dict[str, list[dict]] = {}

    for c in crossings:
        point = to_shape(c.geom)
        # Which routes actually run to this post?
        refs = (
            db.query(RoadLink.ref, func.count(RoadLink.id))
            .filter(RoadLink.is_international == True)  # noqa: E712
            .filter(RoadLink.ref.isnot(None))
            .filter(
                func.ST_DWithin(
                    RoadLink.geom,
                    func.ST_SetSRID(func.ST_MakePoint(point.x, point.y), 4326),
                    0.1,  # ~11 km in degrees
                )
            )
            .group_by(RoadLink.ref)
            .order_by(func.count(RoadLink.id).desc())
            .limit(5)
            .all()
        )
        grouped.setdefault(c.country_b, []).append({
            "crossing": c.name,
            "lat": point.y,
            "lon": point.x,
            "emirate": c.emirate,
            "declared_ref": c.road_ref,
            "connecting_routes": [r for r, _ in refs],
            "freight_enabled": bool(c.freight_enabled),
            "open_24h": bool(c.open_24h),
            "notes": c.notes,
        })

    return {
        "corridors": grouped,
        "countries": sorted(grouped.keys()),
        "total_crossings": len(crossings),
    }


@router.get("/graph")
def graph_info(rebuild: bool = False, db: Session = Depends(get_db)):
    """
    Routable-graph diagnostics.

    `largest_component_pct` is the number to look at when routing says "no
    route found": if the network fragmented, points a few hundred metres apart
    can sit in different components.
    """
    graph = graph_cache.get(db, rebuild=rebuild)
    edges = sum(len(v) for v in graph.adjacency.values())
    info = {
        "built": not graph.is_empty,
        "nodes": len(graph.nodes),
        "edges": edges,
        "links": graph.link_count,
        "avg_degree": round(edges / len(graph.nodes), 2) if graph.nodes else 0,
    }
    if not graph.is_empty:
        info.update(graph.components())
        if info["largest_component_pct"] < 50:
            info["hint"] = (
                "Network is fragmented — ingest the link classes "
                "(motorway_link,trunk_link,primary_link) so carriageways connect."
            )
    return info
