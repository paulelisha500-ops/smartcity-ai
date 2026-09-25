"""
M7 — Emergency routing.

Routes over the **real** UAE road network once M10 has ingested it, and falls
back to the original small demo graph when it hasn't, so the endpoint is never
dead. Emergency runs apply a blue-light factor and ignore tolls: an ambulance
does not detour around a Salik gate.
"""
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.network import RoadLink
from app.routers.auth import require_any, OPERATORS
from app.services.routing import RoadGraph, emergency_routing_service
from app.services.road_graph import route_between

router = APIRouter(prefix="/api/emergency", tags=["emergency"])


# Real UAE facilities, used to populate the dispatch console.
FACILITIES = [
    {"id": "rashid_hospital", "name": "Rashid Hospital", "type": "hospital",
     "lat": 25.2340, "lon": 55.3210, "emirate": "Dubai"},
    {"id": "dubai_hospital", "name": "Dubai Hospital", "type": "hospital",
     "lat": 25.2790, "lon": 55.3080, "emirate": "Dubai"},
    {"id": "am_hospital", "name": "American Hospital Dubai", "type": "hospital",
     "lat": 25.2330, "lon": 55.3080, "emirate": "Dubai"},
    {"id": "civil_defence_bur_dubai", "name": "Civil Defence — Bur Dubai", "type": "fire",
     "lat": 25.2530, "lon": 55.2960, "emirate": "Dubai"},
    {"id": "civil_defence_deira", "name": "Civil Defence — Deira", "type": "fire",
     "lat": 25.2720, "lon": 55.3300, "emirate": "Dubai"},
    {"id": "police_bur_dubai", "name": "Bur Dubai Police Station", "type": "police",
     "lat": 25.2510, "lon": 55.3020, "emirate": "Dubai"},
    {"id": "skmc", "name": "Sheikh Khalifa Medical City", "type": "hospital",
     "lat": 24.4680, "lon": 54.3750, "emirate": "Abu Dhabi"},
    {"id": "sharjah_hospital", "name": "Al Qassimi Hospital", "type": "hospital",
     "lat": 25.3320, "lon": 55.4180, "emirate": "Sharjah"},
]


def _demo_graph() -> RoadGraph:
    """
    Static fallback graph, used only before the real network is ingested.
    Kept so the endpoint degrades gracefully rather than erroring.
    """
    g = RoadGraph()
    g.add_edge("station_A", "junction_1", 90)
    g.add_edge("junction_1", "junction_2", 120)
    g.add_edge("junction_1", "hospital", 300)  # congested direct route
    g.add_edge("junction_2", "hospital", 100)
    g.add_edge("station_A", "junction_2", 220)
    return g


class RouteRequest(BaseModel):
    start: str
    end: str
    vehicle_type: str = "ambulance"


class GeoRouteRequest(BaseModel):
    origin_lat: float = Field(..., ge=-90, le=90)
    origin_lon: float = Field(..., ge=-180, le=180)
    dest_lat: float = Field(..., ge=-90, le=90)
    dest_lon: float = Field(..., ge=-180, le=180)
    vehicle_type: str = "ambulance"
    emergency: bool = True
    avoid_tolls: bool = False


@router.get("/facilities")
def facilities(facility_type: str | None = None, emirate: str | None = None):
    """Hospitals, fire and police stations available as route endpoints."""
    out = FACILITIES
    if facility_type:
        out = [f for f in out if f["type"] == facility_type]
    if emirate:
        out = [f for f in out if f["emirate"] == emirate]
    return out


@router.post("/route")
def emergency_route(payload: RouteRequest, _user=Depends(require_any(*OPERATORS))):
    """Legacy named-node routing over the demo graph."""
    graph = _demo_graph()
    result = emergency_routing_service.shortest_path(graph, payload.start, payload.end)
    return {**result, "vehicle_type": payload.vehicle_type, "network": "demo_graph"}


@router.post("/route-geo")
def emergency_route_geo(payload: GeoRouteRequest, db: Session = Depends(get_db),
                        _user=Depends(require_any(*OPERATORS))):
    """
    Route between two real coordinates over the ingested UAE network.

    Emergency vehicles ignore tolls and get a blue-light time factor; the
    civilian time is returned alongside so dispatch can see the difference.
    """
    has_network = (db.query(func.count(RoadLink.id)).scalar() or 0) > 0
    if not has_network:
        return {
            "reachable": False,
            "network": "none",
            "error": "Road network not ingested. POST /api/network/ingest first.",
        }

    result = route_between(
        db,
        origin=(payload.origin_lat, payload.origin_lon),
        destination=(payload.dest_lat, payload.dest_lon),
        avoid_tolls=payload.avoid_tolls and not payload.emergency,
        emergency=payload.emergency,
    )
    result["vehicle_type"] = payload.vehicle_type
    result["network"] = "uae_osm"
    if result.get("reachable"):
        result["eta_minutes"] = round(result["eta_seconds"] / 60.0, 1)
        result["distance_km"] = round(result["distance_m"] / 1000.0, 2)
    return result


@router.get("/nearest-facility")
def nearest_facility(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180), facility_type: str = "hospital",
                     db: Session = Depends(get_db)):
    """
    Which hospital can actually reach this incident fastest?

    Straight-line proximity is the wrong answer when a creek or a closed
    junction sits in between, so we route to each candidate over the real
    network and rank by drive time.
    """
    from app.services.osm_network import haversine_km

    candidates = [f for f in FACILITIES if f["type"] == facility_type]
    if not candidates:
        return {"error": f"no facilities of type '{facility_type}'"}

    has_network = (db.query(func.count(RoadLink.id)).scalar() or 0) > 0

    # Only route to the nearest few as the crow flies — routing to every
    # facility in the country would be wasteful.
    candidates.sort(key=lambda f: haversine_km(lat, lon, f["lat"], f["lon"]))
    shortlist = candidates[:4]

    ranked = []
    for facility in shortlist:
        straight_km = round(haversine_km(lat, lon, facility["lat"], facility["lon"]), 2)
        entry = {**facility, "straight_line_km": straight_km}
        if has_network:
            route = route_between(db, (lat, lon), (facility["lat"], facility["lon"]),
                                  emergency=True)
            if route.get("reachable"):
                entry["eta_minutes"] = round(route["eta_seconds"] / 60.0, 1)
                entry["distance_km"] = round(route["distance_m"] / 1000.0, 2)
                entry["geometry"] = route["geometry"]
        ranked.append(entry)

    ranked.sort(key=lambda f: f.get("eta_minutes", f["straight_line_km"] * 2))
    for i, entry in enumerate(ranked, start=1):
        entry["rank"] = i

    return {
        "incident": {"lat": lat, "lon": lon},
        "facility_type": facility_type,
        "routed_on_real_network": has_network,
        "candidates": ranked,
        "recommended": ranked[0] if ranked else None,
    }


@router.get("/graph-nodes")
def graph_nodes():
    """Demo-graph node names (legacy endpoint)."""
    return ["station_A", "junction_1", "junction_2", "hospital"]
