from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from geoalchemy2.shape import to_shape
from geoalchemy2.elements import WKTElement

from app.services.ratelimit import rate_limit
from app.database import get_db
from app.models.complaint import Complaint
from app.routers.auth import require_any, ANY_STAFF, MAINTAINERS
from app.schemas.complaint import ComplaintIn, ComplaintOut
from app.services.complaint_nlp import complaint_nlp_service
from app.services.live import publish_event

from typing import Literal

# The only states the KPIs and the UI know about. A free-text status let a typo
# ("Resolved", "done") silently drop a complaint out of the resolution rate.
ComplaintStatus = Literal["submitted", "routed", "in_progress", "resolved"]

router = APIRouter(prefix="/api/complaints", tags=["complaints"])

# Submission stays public — this is the citizen-facing endpoint, the whole
# point of the /report page. Listing and reading individual complaints is
# staff-only (ANY_STAFF, i.e. not public_user): free text a citizen wrote is
# not something other citizens should be able to browse. The aggregate
# summary has no individual text in it, so it's public like the other KPI
# endpoints.


def _to_out(c: Complaint) -> ComplaintOut:
    lat = lon = None
    if c.geom is not None:
        point = to_shape(c.geom)
        lat, lon = point.y, point.x
    return ComplaintOut(
        id=c.id, ts=c.ts, text=c.text, category=c.category, sentiment=c.sentiment,
        sentiment_score=c.sentiment_score, priority=c.priority, priority_score=c.priority_score,
        department=c.department, status=c.status, raw_location_text=c.raw_location_text,
        lat=lat, lon=lon,
    )


@router.post("", response_model=ComplaintOut, dependencies=[Depends(rate_limit("complaint", 10, 60))])
def submit_complaint(payload: ComplaintIn, db: Session = Depends(get_db)):
    """
    Citizen (via web or mobile) submits free text + optional photo/GPS.
    Runs the full NLP pipeline: category -> sentiment -> location -> priority -> routing.
    """
    analysis = complaint_nlp_service.analyze(payload.text)

    lat = payload.lat if payload.lat is not None else analysis.lat
    lon = payload.lon if payload.lon is not None else analysis.lon
    geom = WKTElement(f"POINT({lon} {lat})", srid=4326) if (lat is not None and lon is not None) else None

    complaint = Complaint(
        text=payload.text,
        geom=geom,
        raw_location_text=analysis.location_text,
        category=analysis.category,
        sentiment=analysis.sentiment,
        sentiment_score=analysis.sentiment_score,
        priority=analysis.priority,
        priority_score=analysis.priority_score,
        department=analysis.department,
        status="routed",
        photo_ref=payload.photo_ref,
        reporter_id=payload.reporter_id,
    )
    db.add(complaint)
    db.commit()
    db.refresh(complaint)

    out = _to_out(complaint)
    publish_event({
        "type": "new_complaint",
        "id": complaint.id,
        "category": complaint.category,
        "priority": complaint.priority,
        "department": complaint.department,
        "ts": complaint.ts,
    })
    return out


@router.get("", response_model=list[ComplaintOut])
def list_complaints(
    department: str | None = None,
    priority: str | None = None,
    status: str | None = None,
    db: Session = Depends(get_db),
    _user=Depends(require_any(*ANY_STAFF)),
):
    query = db.query(Complaint)
    if department:
        query = query.filter(Complaint.department == department)
    if priority:
        query = query.filter(Complaint.priority == priority)
    if status:
        query = query.filter(Complaint.status == status)
    complaints = query.order_by(Complaint.ts.desc()).limit(500).all()
    return [_to_out(c) for c in complaints]


@router.get("/{complaint_id}", response_model=ComplaintOut)
def get_complaint(complaint_id: int, db: Session = Depends(get_db),
                  _user=Depends(require_any(*ANY_STAFF))):
    complaint = db.get(Complaint, complaint_id)
    if not complaint:
        raise HTTPException(status_code=404, detail="Complaint not found")
    return _to_out(complaint)


@router.patch("/{complaint_id}/status", response_model=ComplaintOut)
def update_status(complaint_id: int, status: ComplaintStatus, db: Session = Depends(get_db),
                  _user=Depends(require_any(*MAINTAINERS))):
    """Called by department staff (or automatically by IoT signal) to track resolution."""
    complaint = db.get(Complaint, complaint_id)
    if not complaint:
        raise HTTPException(status_code=404, detail="Complaint not found")
    complaint.status = status
    db.commit()
    db.refresh(complaint)
    return _to_out(complaint)


@router.get("/analytics/summary")
def complaint_summary(db: Session = Depends(get_db)):
    """Answers: 'what are citizens complaining about most?'"""
    complaints = db.query(Complaint).all()
    by_category: dict[str, int] = {}
    by_priority: dict[str, int] = {}
    for c in complaints:
        by_category[c.category or "other"] = by_category.get(c.category or "other", 0) + 1
        by_priority[c.priority or "low"] = by_priority.get(c.priority or "low", 0) + 1
    return {
        "total": len(complaints),
        "by_category": by_category,
        "by_priority": by_priority,
    }
