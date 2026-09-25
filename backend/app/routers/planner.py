from fastapi import APIRouter
from pydantic import BaseModel

from app.services.rag_planner import rag_planner_service, Fact
from app.routers.traffic import congestion_hotspots
from app.routers.road_damage import maintenance_priority

router = APIRouter(prefix="/api/planner", tags=["planner"])


class PlannerQuestion(BaseModel):
    question: str


def _assemble_facts() -> list[Fact]:
    """
    This is the 'retrieval' step. In production this is a FAISS similarity
    search over embedded documents/DB rows; here it's a direct assembly of
    structured facts from the live modules, which keeps every answer
    grounded in real (mock-mode) system state rather than invented text.
    """
    facts: list[Fact] = []

    for h in congestion_hotspots(limit=5):
        facts.append(Fact(
            text=f"{h['intersection_name']} currently has the #{h['rank']} highest congestion score "
                 f"in the city at {h['congestion_score']}/100.",
            tags={"congestion", "traffic", "hotspot", "intersection", "widen", "busiest", "junction", "junctions"},
        ))

    for d in maintenance_priority(limit=5):
        facts.append(Fact(
            text=f"{d['name']} has a detected {d['damage_type'].replace('_', ' ')} "
                 f"with severity {d['severity']} (confidence {d['confidence']}).",
            tags={"maintenance", "road", "damage", "pothole", "repair", "condition"},
        ))

    return facts


@router.post("/ask")
def ask_planner(payload: PlannerQuestion):
    """
    'Which roads should be widened?' / 'Show the busiest junctions.' /
    'Estimate travel time after adding one lane.'
    """
    facts = _assemble_facts()
    return rag_planner_service.answer(payload.question, facts)
