"""
M7 — Emergency routing.

Routes over the **real** UAE road network once M10 has ingested it, and falls
back to a small reference graph when it hasn't, so the endpoint is never
dead. Emergency runs apply a blue-light factor and ignore tolls: an ambulance
does not detour around a Salik gate.
"""
import re

from fastapi import APIRouter, Depends, Query
from geoalchemy2.shape import to_shape
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.network import RoadLink
from app.models.place import Place
from app.routers.auth import require_any, OPERATORS
from app.services.routing import RoadGraph, emergency_routing_service
from app.services.road_graph import route_between

router = APIRouter(prefix="/api/emergency", tags=["emergency"])


# Fallback register, used until the gazetteer is loaded. It only covers a few
# Dubai stations, which is why it is a fallback: dispatching a fire to Abu
# Dhabi from Bur Dubai, 150 km away, is not an answer.
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


# OpenStreetMap amenity behind each dispatch service.
SERVICE_SUBCATEGORY = {"hospital": "hospital", "fire": "fire_station", "police": "police"}

# Not everything OSM tags as a fire or police station answers a call: the tags
# also cover fire-safety firms, a training ground, a police college, licensing
# and fines offices. A facility is a dispatch candidate when its name says it
# responds and does not say it is one of those. frontend/src/lib/static-api.ts
# applies the same two lists; keep them in step.
RESPONDS = {
    "fire": re.compile(r"fire station|civil defen[cs]e|rescue|الدفاع المدني|مطافي|اطفاء|إطفاء", re.I),
    "police": re.compile(r"police|شرطة", re.I),
}
DOES_NOT_RESPOND = {
    "fire": re.compile(r"\b(?:co|company|llc|trading|training|safety|systems?)\b", re.I),
    "police": re.compile(
        r"college|licens|fine|parking|kiosk|check ?point|medical|social|special tasks|"
        r"investigation|drugs|community|ministry|office",
        re.I,
    ),
}

# Speed for the stretch between an address and the nearest routable road, which
# the network route does not cover (it runs junction to junction).
ACCESS_SPEED_KMH = 30.0


def responds(service: str, name: str) -> bool:
    """Whether a facility of this service, by its name, is a dispatch candidate."""
    if service in RESPONDS and not RESPONDS[service].search(name):
        return False
    return not (service in DOES_NOT_RESPOND and DOES_NOT_RESPOND[service].search(name))


def facility_register(db: Session, facility_type: str | None = None) -> list[dict]:
    """
    Every hospital, fire station and police station mapped in the gazetteer —
    a few hundred across the seven emirates — or the fallback list before the
    gazetteer has been imported.

    OSM often maps one hospital twice (the amenity and its building), so
    entries with the same name within ~100 m are folded into one.
    """
    wanted = [facility_type] if facility_type else list(SERVICE_SUBCATEGORY)
    out: list[dict] = []
    seen: set[tuple] = set()
    try:
        for service in wanted:
            subcategory = SERVICE_SUBCATEGORY.get(service)
            if not subcategory:
                continue
            for place in db.query(Place).filter(Place.subcategory == subcategory).all():
                if not responds(service, place.name):
                    continue
                point = to_shape(place.geom)
                key = (service, place.name.strip().lower(), round(point.y, 3), round(point.x, 3))
                if key in seen:
                    continue
                seen.add(key)
                out.append({
                    "id": f"osm-{place.id}", "name": place.name, "type": service,
                    "lat": point.y, "lon": point.x, "emirate": place.emirate,
                })
    except SQLAlchemyError:
        out = []
    if out:
        return out
    return [f for f in FACILITIES if not facility_type or f["type"] == facility_type]


def _reference_graph() -> RoadGraph:
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
def facilities(facility_type: str | None = None, emirate: str | None = None,
               db: Session = Depends(get_db)):
    """Hospitals, fire and police stations available as route endpoints."""
    out = facility_register(db, facility_type)
    if emirate:
        out = [f for f in out if f["emirate"] == emirate]
    return out


@router.post("/route")
def emergency_route(payload: RouteRequest, _user=Depends(require_any(*OPERATORS))):
    """Legacy named-node routing over the reference graph."""
    graph = _reference_graph()
    result = emergency_routing_service.shortest_path(graph, payload.start, payload.end)
    return {**result, "vehicle_type": payload.vehicle_type, "network": "reference_graph"}


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

    candidates = facility_register(db, facility_type)
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
                # Door to door: the network leg runs between the junctions
                # nearest each end, so add the drive to and from them. Without
                # this a station 1.3 km away that shares the incident's nearest
                # junction was reported as 0 minutes.
                access_m = route.get("origin_snap_m", 0.0) + route.get("destination_snap_m", 0.0)
                eta_s = route["eta_seconds"] + access_m / 1000.0 / ACCESS_SPEED_KMH * 3600.0
                entry["eta_minutes"] = round(eta_s / 60.0, 1)
                entry["distance_km"] = round((route["distance_m"] + access_m) / 1000.0, 2)
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
    """Reference-graph node names (legacy endpoint)."""
    return ["station_A", "junction_1", "junction_2", "hospital"]
