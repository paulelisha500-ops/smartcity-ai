"""
M12 — new route / corridor design API.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.services.ratelimit import rate_limit
from app.database import get_db
from app.routers.auth import get_current_user
from app.services import route_designer

router = APIRouter(prefix="/api/route-design", tags=["route-design"])

# Presets and saved proposals are public reads (informational, low cost).
# /analyze requires login — any authenticated role, not a specific one —
# because each call runs A* routing plus a corridor-gap scan over the road
# table, which is cheap once but not something to leave open to anonymous
# repeated calls.


class DesignRequest(BaseModel):
    origin_lat: float = Field(..., ge=-90, le=90)
    origin_lon: float = Field(..., ge=-180, le=180)
    dest_lat: float = Field(..., ge=-90, le=90)
    dest_lon: float = Field(..., ge=-180, le=180)
    origin_name: str = Field("Origin", max_length=120)
    destination_name: str = Field("Destination", max_length=120)
    lanes: int = Field(6, ge=2, le=12)
    save: bool = False


# Corridors worth studying, pre-filled so the page is useful immediately.
PRESETS = [
    {
        "id": "dubai_islands",
        "name": "Bur Dubai → Dubai Islands",
        "origin_name": "Bur Dubai", "origin_lat": 25.2600, "origin_lon": 55.2970,
        "destination_name": "Dubai Islands", "dest_lat": 25.2960, "dest_lon": 55.3160,
        "why": "The corridor the RTA is closing with a 1,425 m bridge — a live check "
               "that the tool reaches the same conclusion as the real programme.",
    },
    {
        "id": "reem_island",
        "name": "Abu Dhabi CBD → Al Reem Island",
        "origin_name": "Abu Dhabi CBD", "origin_lat": 24.4900, "origin_lon": 54.3700,
        "destination_name": "Al Reem Island", "dest_lat": 24.4990, "dest_lon": 54.4020,
        "why": "Recently solved with two marine bridges (AED 450m).",
    },
    {
        "id": "dubai_sharjah",
        "name": "Dubai Silicon Oasis → Sharjah University City",
        "origin_name": "Dubai Silicon Oasis", "origin_lat": 25.1180, "origin_lon": 55.3800,
        "destination_name": "Sharjah University City", "dest_lat": 25.2930, "dest_lon": 55.4900,
        "why": "The heaviest cross-emirate commute in the country.",
    },
    {
        "id": "hatta_corridor",
        "name": "Dubai → Hatta (Oman border)",
        "origin_name": "Dubai", "origin_lat": 25.2048, "origin_lon": 55.2708,
        "destination_name": "Hatta / Al Wajajah crossing", "dest_lat": 24.7900, "dest_lon": 56.1400,
        "why": "Cross-border freight corridor to Oman.",
    },
]


@router.get("/presets")
def presets():
    """Ready-made corridor studies for the planning console."""
    return PRESETS


@router.post("/analyze", dependencies=[Depends(rate_limit("corridor", 20, 60))])
def analyze(payload: DesignRequest, db: Session = Depends(get_db),
           _user=Depends(get_current_user)):
    """
    Assess a corridor: what drivers face today, how direct it could be, what
    the physical gap is, what is already being built, and what it would cost.
    """
    if (payload.origin_lat, payload.origin_lon) == (payload.dest_lat, payload.dest_lon):
        raise HTTPException(status_code=400, detail="Origin and destination are the same point.")
    return route_designer.design_route(
        db,
        origin=(payload.origin_lat, payload.origin_lon),
        destination=(payload.dest_lat, payload.dest_lon),
        origin_name=payload.origin_name,
        destination_name=payload.destination_name,
        lanes=payload.lanes,
        save=payload.save,
    )


@router.get("/proposals")
def proposals(limit: int = 50, db: Session = Depends(get_db)):
    """Saved corridor designs, newest first."""
    return route_designer.list_proposals(db, limit=limit)
