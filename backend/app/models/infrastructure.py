"""
M11 — infrastructure & bridge project tracking.
M12 — proposed new-route (corridor) designs.

`InfrastructureProject` is the register of real capital works — bridges,
tunnels, corridor widenings — with capacity and schedule, so the planner can
answer "what is already being built here?" before proposing anything new.

`RouteProposal` stores a corridor the platform itself designed (M12), with the
geometry it would follow and the metrics that justify it.
"""
from datetime import datetime

from sqlalchemy import Column, Integer, String, Float, DateTime, Text, Boolean
from geoalchemy2 import Geometry

from app.database import Base


class InfrastructureProject(Base):
    __tablename__ = "infrastructure_project"

    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    project_type = Column(String, nullable=False)   # bridge | tunnel | corridor | interchange | rail | pedestrian_bridge
    status = Column(String, default="planned")       # planned | under_construction | completed
    authority = Column(String, nullable=True)        # Dubai RTA | Abu Dhabi DMT | ...
    emirate = Column(String, index=True, nullable=True)

    geom = Column(Geometry("GEOMETRY", srid=4326), nullable=True)  # point or line

    # Engineering / impact figures
    length_m = Column(Float, nullable=True)
    lanes = Column(Integer, nullable=True)
    capacity_vph = Column(Integer, nullable=True)    # vehicles per hour
    cost_aed_m = Column(Float, nullable=True)        # millions AED
    travel_time_saving_pct = Column(Float, nullable=True)

    announced_year = Column(Integer, nullable=True)
    completion_year = Column(Integer, nullable=True)
    opened_on = Column(DateTime, nullable=True)

    description = Column(Text, nullable=True)
    source_url = Column(String, nullable=True)       # provenance for every figure
    created_at = Column(DateTime, default=datetime.utcnow)


class RouteProposal(Base):
    """A corridor designed by M12, kept so planners can compare options."""

    __tablename__ = "route_proposal"

    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    geom = Column(Geometry("LINESTRING", srid=4326), nullable=True)

    origin_name = Column(String, nullable=True)
    destination_name = Column(String, nullable=True)

    strategy = Column(String, nullable=True)         # existing | widen | new_corridor | bridge
    length_km = Column(Float, nullable=True)
    est_travel_time_min = Column(Float, nullable=True)
    baseline_travel_time_min = Column(Float, nullable=True)
    time_saving_pct = Column(Float, nullable=True)
    est_cost_aed_m = Column(Float, nullable=True)
    est_capacity_vph = Column(Integer, nullable=True)
    feasibility_score = Column(Float, nullable=True)  # 0-100
    crosses_water = Column(Boolean, default=False)
    conflicts = Column(Text, nullable=True)          # JSON list of clashes found

    rationale = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
