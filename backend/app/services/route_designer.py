"""
M12 — new route (corridor) design.

Answers the question a city planner actually asks: *"people are taking 40
minutes to get from A to B — should we build something, and if so what?"*

The method is deliberately transparent rather than a black box, because a
corridor recommendation has to survive a review board:

1. **Measure the status quo.** Route A→B over the real network (M7/M10) to get
   the distance and time drivers experience today.
2. **Compare against the ideal.** A straight line A→B is the theoretical
   minimum. `detour_ratio = network_distance / straight_line_distance` is the
   standard circuity measure; ~1.2-1.3 is healthy for a grid, and above ~1.6
   means the network is forcing a significant detour.
3. **Find the gap.** Sample the ideal corridor and measure how far each sample
   sits from any existing road. A long run of samples with no road nearby is
   the physical gap — water, desert or undeveloped land — that explains the
   detour and tells us what kind of structure is needed.
4. **Check what is already planned.** Cross-reference the M11 project register
   so the tool never proposes something an authority is already building.
5. **Score and cost it.** Feasibility from the evidence above; cost from
   published UAE unit rates.

Everything returned is an option-screening estimate, not a design.
"""
from __future__ import annotations

import json
import math
from typing import Optional

from geoalchemy2.shape import to_shape
from sqlalchemy.orm import Session

from app.models.infrastructure import InfrastructureProject, RouteProposal
from app.models.network import RoadLink
from app.services.osm_network import haversine_km
from app.services.road_graph import route_between
from app.services.infrastructure import estimate_cost_aed_m, estimate_capacity_vph

# A sample further than this from any road is "unserved" — no road corridor.
UNSERVED_THRESHOLD_M = 1200.0
# Detour ratio above which a new connection is worth studying.
DETOUR_TRIGGER = 1.45
# How finely we sample the ideal corridor.
CORRIDOR_SAMPLES = 40


def interpolate(origin: tuple[float, float], destination: tuple[float, float],
                n: int) -> list[tuple[float, float]]:
    """n evenly spaced points along the great-circle-ish straight line."""
    (lat1, lon1), (lat2, lon2) = origin, destination
    return [
        (lat1 + (lat2 - lat1) * i / (n - 1), lon1 + (lon2 - lon1) * i / (n - 1))
        for i in range(n)
    ]


def _bbox_around(points: list[tuple[float, float]], pad_deg: float = 0.05):
    lats = [p[0] for p in points]
    lons = [p[1] for p in points]
    return (min(lats) - pad_deg, min(lons) - pad_deg,
            max(lats) + pad_deg, max(lons) + pad_deg)


def corridor_gap_analysis(db: Session, origin: tuple[float, float],
                          destination: tuple[float, float]) -> dict:
    """
    How much of the ideal corridor has no road anywhere near it?

    We only load links whose midpoint falls in the corridor bounding box,
    which keeps this to a bounded scan instead of the whole country.
    """
    samples = interpolate(origin, destination, CORRIDOR_SAMPLES)

    # One indexed nearest-road lookup per sample, done in PostGIS.
    #
    # The previous version pulled every road link in the country through
    # Shapely in Python (~170k rows) on every request, which took 45-145 s.
    # ST_DWithin uses the GiST index, so each sample only touches links within
    # SEARCH_DEG, and ST_DistanceSphere returns metres directly. Only the
    # strategic classes count as "a road serving this corridor" — a cul-de-sac
    # 300 m off the line does not close a water crossing.
    from sqlalchemy import func

    classes = ["motorway", "trunk", "primary", "secondary",
               "motorway_link", "trunk_link", "primary_link"]
    search_deg = 0.05  # ~5.5 km; anything farther is "unserved" regardless
    far_m = search_deg * 111_320.0

    distances: list[float] = []
    for lat, lon in samples:
        pt = func.ST_SetSRID(func.ST_MakePoint(lon, lat), 4326)
        nearest = (
            db.query(func.min(func.ST_DistanceSphere(RoadLink.geom, pt)))
            .filter(RoadLink.highway.in_(classes))
            .filter(func.ST_DWithin(RoadLink.geom, pt, search_deg))
            .scalar()
        )
        distances.append(float(nearest) if nearest is not None else far_m)

    unserved = [d for d in distances if d > UNSERVED_THRESHOLD_M]

    # Longest consecutive run of unserved samples → the real physical gap.
    longest_run = run = 0
    for d in distances:
        run = run + 1 if d > UNSERVED_THRESHOLD_M else 0
        longest_run = max(longest_run, run)

    total_km = haversine_km(*origin, *destination)
    gap_km = total_km * longest_run / len(samples)

    return {
        "samples": len(samples),
        "unserved_samples": len(unserved),
        "unserved_pct": round(len(unserved) / len(samples) * 100, 1),
        "max_distance_to_road_m": round(max(distances), 1),
        "mean_distance_to_road_m": round(sum(distances) / len(distances), 1),
        "longest_gap_km": round(gap_km, 2),
    }


def nearby_projects(db: Session, points: list[tuple[float, float]],
                    radius_km: float = 6.0) -> list[dict]:
    """Existing/planned works close enough to the corridor to matter."""
    out = []
    for project in db.query(InfrastructureProject).all():
        if project.geom is None:
            continue
        try:
            shape = to_shape(project.geom)
        except Exception:
            continue
        plat, plon = (shape.centroid.y, shape.centroid.x)
        nearest = min(haversine_km(lat, lon, plat, plon) for lat, lon in points)
        if nearest <= radius_km:
            out.append({
                "id": project.id,
                "name": project.name,
                "type": project.project_type,
                "status": project.status,
                "authority": project.authority,
                "distance_km": round(nearest, 2),
                "capacity_vph": project.capacity_vph,
                "source_url": project.source_url,
            })
    return sorted(out, key=lambda p: p["distance_km"])


def design_route(db: Session, origin: tuple[float, float], destination: tuple[float, float],
                 origin_name: str = "Origin", destination_name: str = "Destination",
                 lanes: int = 6, save: bool = False) -> dict:
    """Run the full corridor assessment and return a costed recommendation."""
    straight_km = haversine_km(*origin, *destination)
    existing = route_between(db, origin, destination)

    samples = interpolate(origin, destination, CORRIDOR_SAMPLES)
    gap = corridor_gap_analysis(db, origin, destination)
    conflicts = nearby_projects(db, samples)

    baseline_min: Optional[float] = None
    network_km: Optional[float] = None
    detour_ratio: Optional[float] = None

    if existing.get("reachable"):
        baseline_min = round(existing["eta_seconds"] / 60.0, 1)
        network_km = round(existing["distance_m"] / 1000.0, 2)
        detour_ratio = round(network_km / straight_km, 2) if straight_km > 0 else None

    # ---- pick a build strategy from the evidence ---------------------------
    unserved_pct = gap.get("unserved_pct", 0.0)
    longest_gap = gap.get("longest_gap_km", 0.0)

    if not existing.get("reachable"):
        strategy, build_type = "new_corridor", "at_grade"
        rationale = "No route exists on the current network between these points."
    elif unserved_pct >= 35 and longest_gap >= 1.0:
        strategy, build_type = "bridge", "bridge"
        rationale = (
            f"{unserved_pct}% of the direct corridor has no road within "
            f"{UNSERVED_THRESHOLD_M:.0f} m, with an unbroken {longest_gap} km gap — "
            "consistent with a water or undeveloped crossing that a fixed link would close."
        )
    elif detour_ratio and detour_ratio >= DETOUR_TRIGGER:
        strategy, build_type = "new_corridor", "elevated"
        rationale = (
            f"Drivers travel {network_km} km to cover {round(straight_km, 2)} km of "
            f"straight-line distance (detour ratio {detour_ratio}). A direct link "
            "would remove that circuity."
        )
    else:
        strategy, build_type = "widen", "widening"
        rationale = (
            f"The existing route is reasonably direct (detour ratio {detour_ratio}). "
            "Capacity, not alignment, is the constraint — widening or junction "
            "upgrades will out-perform a new corridor."
        )

    build_km = straight_km if strategy != "widen" else (network_km or straight_km)
    cost = estimate_cost_aed_m(build_km, build_type)
    capacity = estimate_capacity_vph(lanes)

    # New alignment at ~90 km/h design speed; widening keeps the existing path
    # but relieves congestion, modelled as a 25% time improvement.
    if strategy == "widen" and baseline_min:
        proposed_min = round(baseline_min * 0.75, 1)
    else:
        proposed_min = round(build_km / 90.0 * 60.0, 1)

    saving_pct = (
        round((baseline_min - proposed_min) / baseline_min * 100, 1)
        if baseline_min and baseline_min > 0 else None
    )

    feasibility = _feasibility_score(saving_pct, cost, conflicts, strategy)

    result = {
        "origin": {"name": origin_name, "lat": origin[0], "lon": origin[1]},
        "destination": {"name": destination_name, "lat": destination[0], "lon": destination[1]},
        "straight_line_km": round(straight_km, 2),
        "existing_route": {
            "reachable": existing.get("reachable", False),
            "distance_km": network_km,
            "travel_time_min": baseline_min,
            "detour_ratio": detour_ratio,
            "geometry": existing.get("geometry", []),
            "error": existing.get("error"),
        },
        "proposed": {
            "strategy": strategy,
            "build_type": build_type,
            "geometry": [[lat, lon] for lat, lon in samples],
            "length_km": round(build_km, 2),
            "lanes": lanes,
            "capacity_vph": capacity,
            "est_travel_time_min": proposed_min,
            "est_cost_aed_m": cost,
            "time_saving_pct": saving_pct,
        },
        "corridor_gap": gap,
        "conflicts": conflicts,
        "feasibility_score": feasibility,
        "recommendation": _recommendation(feasibility, strategy, conflicts),
        "rationale": rationale,
        "method_note": (
            "Option-screening estimate. Costs use published UAE unit rates; "
            "alignment is a straight-line corridor, not a surveyed route."
        ),
    }

    if save:
        proposal = RouteProposal(
            name=f"{origin_name} → {destination_name} ({strategy})",
            origin_name=origin_name,
            destination_name=destination_name,
            strategy=strategy,
            length_km=round(build_km, 2),
            est_travel_time_min=proposed_min,
            baseline_travel_time_min=baseline_min,
            time_saving_pct=saving_pct,
            est_cost_aed_m=cost,
            est_capacity_vph=capacity,
            feasibility_score=feasibility,
            crosses_water=strategy == "bridge",
            conflicts=json.dumps(conflicts),
            rationale=rationale,
            geom=(
                "SRID=4326;LINESTRING("
                + ", ".join(f"{lon} {lat}" for lat, lon in samples)
                + ")"
            ),
        )
        db.add(proposal)
        db.commit()
        db.refresh(proposal)
        result["saved_proposal_id"] = proposal.id

    return result


def _feasibility_score(saving_pct: Optional[float], cost_aed_m: float,
                       conflicts: list[dict], strategy: str) -> float:
    """
    0-100. Rewards time saved, penalises cost and duplication of works that
    are already funded.
    """
    score = 50.0

    if saving_pct is not None:
        score += min(30.0, max(-20.0, saving_pct * 0.6))

    # Cost drag: every AED 500m of capital knocks off ~8 points.
    score -= min(30.0, cost_aed_m / 500.0 * 8.0)

    # Something already being built here is a strong reason not to duplicate.
    for c in conflicts:
        if c["status"] == "under_construction" and c["distance_km"] < 3:
            score -= 18.0
        elif c["status"] == "planned" and c["distance_km"] < 3:
            score -= 8.0
        elif c["status"] == "completed" and c["distance_km"] < 2:
            score -= 12.0

    if strategy == "widen":
        score += 8.0  # cheapest, least disruptive intervention

    return round(min(100.0, max(0.0, score)), 1)


def _recommendation(score: float, strategy: str, conflicts: list[dict]) -> str:
    blocking = [c for c in conflicts
                if c["status"] == "under_construction" and c["distance_km"] < 3]
    if blocking:
        return (
            f"Hold — {blocking[0]['name']} is already under construction "
            f"{blocking[0]['distance_km']} km away. Re-assess once it opens."
        )
    if score >= 70:
        return f"Advance to feasibility study — {strategy.replace('_', ' ')} is well justified."
    if score >= 45:
        return f"Shortlist — {strategy.replace('_', ' ')} is viable but needs a cost-benefit case."
    return "Do not pursue on current evidence — benefits do not justify the capital cost."


def list_proposals(db: Session, limit: int = 50) -> list[dict]:
    rows = (
        db.query(RouteProposal)
        .order_by(RouteProposal.created_at.desc())
        .limit(limit)
        .all()
    )
    return [
        {
            "id": r.id,
            "name": r.name,
            "strategy": r.strategy,
            "length_km": r.length_km,
            "est_travel_time_min": r.est_travel_time_min,
            "baseline_travel_time_min": r.baseline_travel_time_min,
            "time_saving_pct": r.time_saving_pct,
            "est_cost_aed_m": r.est_cost_aed_m,
            "est_capacity_vph": r.est_capacity_vph,
            "feasibility_score": r.feasibility_score,
            "rationale": r.rationale,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]
