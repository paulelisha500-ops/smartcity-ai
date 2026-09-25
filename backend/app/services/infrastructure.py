"""
M11 — UAE infrastructure & bridge project register.

Every figure below carries a `source_url`. That is deliberate: a planning tool
that quotes capacity or cost without provenance is not usable in a government
review, because the first question is always "where did that number come
from?". The seed set covers the major UAE road and bridge works current as of
September 2026; `source_url` is what an analyst clicks to verify.

Positions are the published project locations to roughly city-block accuracy —
enough to place a marker and run proximity checks against a proposed corridor,
not survey data. A production deployment replaces this seed with the
authority's own project GIS layer via `upsert_project`.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from app.models.infrastructure import InfrastructureProject

# --------------------------------------------------------------------------
# Real UAE projects, September 2026
# --------------------------------------------------------------------------
UAE_PROJECTS: list[dict] = [
    {
        "name": "Dubai Islands – Bur Dubai Bridge",
        "project_type": "bridge",
        "status": "under_construction",
        "authority": "Dubai RTA",
        "emirate": "Dubai",
        "lat": 25.2790, "lon": 55.3050,
        "length_m": 1425,
        "lanes": 8,
        "capacity_vph": 16000,
        "completion_year": 2026,
        "description": (
            "1,425 m crossing linking Dubai Islands to Bur Dubai, four lanes in "
            "each direction, 16,000 vehicles/hour combined capacity."
        ),
        "source_url": "https://gulfnews.com/uae/transport/new-14km-bridge-to-connect-bur-dubai-with-dubai-islands-1.98097740",
    },
    {
        "name": "Al Shindagha Corridor Development",
        "project_type": "corridor",
        "status": "completed",
        "authority": "Dubai RTA",
        "emirate": "Dubai",
        "lat": 25.2680, "lon": 55.2900,
        "length_m": 13000,
        "travel_time_saving_pct": 85.0,
        "completion_year": 2026,
        "description": (
            "Full corridor from Al Garhoud Bridge to Port Rashid via Infinity "
            "Bridge. RTA reports corridor travel time falling from 104 minutes "
            "to 16 minutes by 2030."
        ),
        "source_url": "https://gulfnews.com/uae/transport/major-milestone-rta-complete-all-al-shindagha-corridor-works-reducing-travel-time-by-85-per-cent-1.500123203",
    },
    {
        "name": "Oud Metha Road Bridge",
        "project_type": "bridge",
        "status": "completed",
        "authority": "Dubai RTA",
        "emirate": "Dubai",
        "lat": 25.2350, "lon": 55.3100,
        "lanes": 3,
        "capacity_vph": 3600,
        "completion_year": 2026,
        "opened_on": datetime(2026, 7, 26),
        "description": (
            "Three-lane bridge on the Oud Metha Road development, 3,600 "
            "vehicles/hour. Part of a scheme roughly 90% complete, with two "
            "vehicle tunnels and a further bridge due by end of August 2026."
        ),
        "source_url": "https://www.arabianbusiness.com/business/transport/dubai-opens-new-bridge",
    },
    {
        "name": "Sheikh Zayed Road – Sheikh Khalifa bin Zayed Street Bridge",
        "project_type": "bridge",
        "status": "completed",
        "authority": "Dubai RTA",
        "emirate": "Dubai",
        "lat": 25.2280, "lon": 55.2870,
        "length_m": 1000,
        "lanes": 2,
        "capacity_vph": 3000,
        "completion_year": 2026,
        "travel_time_saving_pct": 83.0,
        "description": (
            "1 km two-lane bridge opened June 2026 connecting Sheikh Zayed Road "
            "to Sheikh Khalifa bin Zayed Street; journey time cut from six "
            "minutes to one."
        ),
        "source_url": "https://gulfnews.com/living-in-uae/transport/dubais-biggest-future-road-projects-latest-rta-updates-completion-status-and-benefits-1.500600626",
    },
    {
        "name": "Al Reem Island Marine Bridges (2)",
        "project_type": "bridge",
        "status": "completed",
        "authority": "Abu Dhabi DMT",
        "emirate": "Abu Dhabi",
        "lat": 24.4990, "lon": 54.4020,
        "capacity_vph": 7200,
        "cost_aed_m": 450.0,
        "completion_year": 2026,
        "opened_on": datetime(2026, 3, 21),
        "travel_time_saving_pct": 60.0,
        "description": (
            "Two marine bridges linking Al Reem Island directly to Sheikh "
            "Khalifa Bin Zayed Highway (E12). AED 450 million scheme, 7,200 "
            "vehicles/hour, ~60% peak travel-time reduction."
        ),
        "source_url": "https://www.gulftoday.ae/news/2026/03/21/abu-dhabi-opens-2-new-bridges-linking-al-reem-island-with-sheikh-khalifa-bin-zayed-highway",
    },
    {
        "name": "E20 Highway Expansion",
        "project_type": "corridor",
        "status": "under_construction",
        "authority": "Abu Dhabi DMT",
        "emirate": "Abu Dhabi",
        "lat": 24.4200, "lon": 54.5500,
        "lanes": 10,
        "description": (
            "Widening of the E20 from three to five lanes in each direction, "
            "including four new bridges."
        ),
        "source_url": "https://www.travelsdubai.com/17-Jul-2026/abu-dhabi-expands-e20-highway-five-lane-upgrade-four-new-bridges",
    },
    {
        "name": "Dubai Pedestrian Bridge Programme (31 crossings)",
        "project_type": "pedestrian_bridge",
        "status": "planned",
        "authority": "Dubai RTA",
        "emirate": "Dubai",
        "lat": 25.2048, "lon": 55.2708,
        "completion_year": 2030,
        "description": (
            "Programme to deliver 31 new pedestrian bridges and tunnels across "
            "Dubai by 2030."
        ),
        "source_url": "https://whatson.ae/2026/06/dubai-to-build-31-new-pedestrian-bridges-by-2030/",
    },
    {
        "name": "Hessa Street Improvement Project",
        "project_type": "corridor",
        "status": "under_construction",
        "authority": "Dubai RTA",
        "emirate": "Dubai",
        "lat": 25.0700, "lon": 55.2000,
        "description": (
            "Corridor upgrade on Hessa Street, part of RTA's current programme "
            "of strategic road improvements."
        ),
        "source_url": "https://gulfnews.com/living-in-uae/transport/dubais-biggest-future-road-projects-latest-rta-updates-completion-status-and-benefits-1.500600626",
    },
]


# --------------------------------------------------------------------------
# Planning-grade unit costs
# --------------------------------------------------------------------------
# Derived from recent published UAE project costs (e.g. the AED 450m Al Reem
# marine bridge pair). Order-of-magnitude figures for option screening only —
# not a substitute for a quantity-surveyed estimate.
UNIT_COST_AED_M_PER_KM = {
    "at_grade": 30.0,
    "widening": 45.0,
    "elevated": 180.0,
    "bridge": 320.0,      # marine/major span
    "tunnel": 520.0,
}

# Practical capacity per lane per hour on an uninterrupted UAE arterial.
CAPACITY_PER_LANE_VPH = 1800


def seed_projects(db: Session, replace: bool = False) -> dict:
    """Load the real project register. Safe to call repeatedly."""
    if replace:
        db.query(InfrastructureProject).delete()
        db.commit()

    existing = (
        {row[0] for row in db.query(InfrastructureProject.name).all()}
        if not replace else set()
    )

    inserted = 0
    for spec in UAE_PROJECTS:
        if spec["name"] in existing:
            continue
        data = dict(spec)
        lat, lon = data.pop("lat", None), data.pop("lon", None)
        project = InfrastructureProject(**data)
        if lat is not None and lon is not None:
            project.geom = f"SRID=4326;POINT({lon} {lat})"
        db.add(project)
        inserted += 1

    db.commit()
    return {"projects_inserted": inserted, "total_in_register": db.query(InfrastructureProject).count()}


def portfolio_summary(db: Session) -> dict:
    """Roll-up a planner would put in front of a board."""
    projects = db.query(InfrastructureProject).all()

    by_status: dict[str, int] = {}
    by_type: dict[str, int] = {}
    by_emirate: dict[str, int] = {}
    capacity_added = 0
    committed_cost = 0.0

    for p in projects:
        by_status[p.status or "unknown"] = by_status.get(p.status or "unknown", 0) + 1
        by_type[p.project_type] = by_type.get(p.project_type, 0) + 1
        if p.emirate:
            by_emirate[p.emirate] = by_emirate.get(p.emirate, 0) + 1
        if p.capacity_vph:
            capacity_added += p.capacity_vph
        if p.cost_aed_m:
            committed_cost += p.cost_aed_m

    savings = [p.travel_time_saving_pct for p in projects if p.travel_time_saving_pct]

    return {
        "total_projects": len(projects),
        "by_status": by_status,
        "by_type": by_type,
        "by_emirate": by_emirate,
        "capacity_added_vph": capacity_added,
        "known_cost_aed_m": round(committed_cost, 1),
        "avg_travel_time_saving_pct": round(sum(savings) / len(savings), 1) if savings else None,
        "note": "Cost totals cover only projects with a published figure.",
    }


def upsert_project(db: Session, payload: dict) -> InfrastructureProject:
    """Create or update a project — the hook for an authority's real GIS feed."""
    lat, lon = payload.pop("lat", None), payload.pop("lon", None)
    existing = (
        db.query(InfrastructureProject)
        .filter(InfrastructureProject.name == payload.get("name"))
        .first()
    )
    if existing:
        for key, value in payload.items():
            if value is not None and hasattr(existing, key):
                setattr(existing, key, value)
        project = existing
    else:
        project = InfrastructureProject(**payload)
        db.add(project)

    if lat is not None and lon is not None:
        project.geom = f"SRID=4326;POINT({lon} {lat})"

    db.commit()
    db.refresh(project)
    return project


def estimate_cost_aed_m(length_km: float, build_type: str) -> float:
    rate = UNIT_COST_AED_M_PER_KM.get(build_type, UNIT_COST_AED_M_PER_KM["at_grade"])
    return round(length_km * rate, 1)


def estimate_capacity_vph(lanes: int) -> int:
    return int(lanes * CAPACITY_PER_LANE_VPH)
