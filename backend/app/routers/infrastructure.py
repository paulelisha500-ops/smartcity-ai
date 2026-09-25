"""
M11 — infrastructure & bridge projects API.
"""
from fastapi import APIRouter, Depends, HTTPException
from geoalchemy2.shape import to_shape
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.infrastructure import InfrastructureProject
from app.routers.auth import require_any, PLANNERS
from app.services import infrastructure as infra

router = APIRouter(prefix="/api/infrastructure", tags=["infrastructure"])

# Reads are public — a bridge/corridor project register is exactly the kind of
# thing a government transparency site publishes. Writes (seed/create/delete)
# are PLANNERS only (admin, city_planner).


class ProjectIn(BaseModel):
    name: str
    project_type: str
    status: str = "planned"
    authority: str | None = None
    emirate: str | None = None
    lat: float | None = None
    lon: float | None = None
    length_m: float | None = None
    lanes: int | None = None
    capacity_vph: int | None = None
    cost_aed_m: float | None = None
    travel_time_saving_pct: float | None = None
    announced_year: int | None = None
    completion_year: int | None = None
    description: str | None = None
    source_url: str | None = None


def _out(p: InfrastructureProject) -> dict:
    lat = lon = None
    if p.geom is not None:
        try:
            shape = to_shape(p.geom)
            lat, lon = shape.centroid.y, shape.centroid.x
        except Exception:
            pass
    return {
        "id": p.id,
        "name": p.name,
        "project_type": p.project_type,
        "status": p.status,
        "authority": p.authority,
        "emirate": p.emirate,
        "lat": lat,
        "lon": lon,
        "length_m": p.length_m,
        "lanes": p.lanes,
        "capacity_vph": p.capacity_vph,
        "cost_aed_m": p.cost_aed_m,
        "travel_time_saving_pct": p.travel_time_saving_pct,
        "announced_year": p.announced_year,
        "completion_year": p.completion_year,
        "opened_on": p.opened_on.isoformat() if p.opened_on else None,
        "description": p.description,
        "source_url": p.source_url,
    }


@router.get("/projects")
def list_projects(status: str | None = None, project_type: str | None = None,
                  emirate: str | None = None, db: Session = Depends(get_db)):
    query = db.query(InfrastructureProject)
    if status:
        query = query.filter(InfrastructureProject.status == status)
    if project_type:
        query = query.filter(InfrastructureProject.project_type == project_type)
    if emirate:
        query = query.filter(InfrastructureProject.emirate == emirate)
    rows = query.order_by(InfrastructureProject.completion_year.asc().nullslast()).all()
    return [_out(p) for p in rows]


@router.get("/summary")
def summary(db: Session = Depends(get_db)):
    """Portfolio roll-up: status mix, capacity added, committed spend."""
    return infra.portfolio_summary(db)


@router.get("/bridges")
def bridges(db: Session = Depends(get_db)):
    """Just the bridge programme — the headline structures."""
    rows = (
        db.query(InfrastructureProject)
        .filter(InfrastructureProject.project_type.in_(["bridge", "pedestrian_bridge"]))
        .order_by(InfrastructureProject.capacity_vph.desc().nullslast())
        .all()
    )
    return [_out(p) for p in rows]


@router.post("/seed")
def seed(replace: bool = False, db: Session = Depends(get_db),
         _user=Depends(require_any(*PLANNERS))):
    """Load the current UAE project register (every figure carries a source)."""
    return infra.seed_projects(db, replace=replace)


@router.post("/projects")
def create_project(payload: ProjectIn, db: Session = Depends(get_db),
                   _user=Depends(require_any(*PLANNERS))):
    """Create/update a project — the hook for an authority's own GIS feed."""
    project = infra.upsert_project(db, payload.model_dump())
    return _out(project)


@router.delete("/projects/{project_id}")
def delete_project(project_id: int, db: Session = Depends(get_db),
                   _user=Depends(require_any(*PLANNERS))):
    project = db.get(InfrastructureProject, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    db.delete(project)
    db.commit()
    return {"deleted": project_id}
