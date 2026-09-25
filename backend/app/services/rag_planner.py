"""
AI City Planner — LLM + RAG (Module 5).

Production path: LangGraph agent with tools (SQL query over PostGIS,
spatial query, document retrieval from FAISS over GIS layers / capital
project docs / historical incident reports) + a hosted LLM for synthesis,
with citations back to the underlying rows/documents.

Working baseline today: a real retrieval layer (keyword-overlap scoring
over structured "facts" assembled from the current DB state — congestion
rankings, complaint hotspots, road condition scores) plus a deterministic
answer synthesizer. No external LLM call, no API key, but the retrieval
and grounding pattern is the real one: every answer only uses facts that
were actually retrieved, and every answer lists which facts it used —
same contract a production LangChain/FAISS pipeline would need to honor.
"""
from dataclasses import dataclass

from app.config import get_settings

settings = get_settings()


@dataclass
class Fact:
    text: str
    tags: set[str]


def _score(query_tokens: set[str], fact: Fact) -> int:
    return len(query_tokens & fact.tags)


class RAGPlannerService:
    def answer(self, question: str, facts: list[Fact]) -> dict:
        if settings.model_mode == "production":
            # -----------------------------------------------------------
            # PRODUCTION EXTENSION POINT
            # retriever = faiss_store.as_retriever()
            # agent = build_langgraph_agent(llm, tools=[sql_tool, spatial_tool, retriever])
            # return agent.invoke({"question": question})
            # -----------------------------------------------------------
            raise NotImplementedError("Implement answer() with LangChain/LangGraph + FAISS + LLM here.")

        query_tokens = set(w.strip(".,?!").lower() for w in question.split())
        ranked = sorted(facts, key=lambda f: _score(query_tokens, f), reverse=True)
        used = [f for f in ranked if _score(query_tokens, f) > 0][:5]

        if not used:
            return {
                "answer": (
                    "I don't have enough current data to answer that precisely. "
                    "Try asking about congestion, complaints, road condition, or "
                    "recent accidents at a specific intersection or road."
                ),
                "sources_used": [],
            }

        summary = " ".join(f.text for f in used)
        answer = (
            f"Based on current city data: {summary} "
            f"This reflects {len(used)} data point(s) retrieved for your question; "
            f"in production this is grounded with live SQL/spatial queries and cites exact rows."
        )
        return {"answer": answer, "sources_used": [f.text for f in used]}


rag_planner_service = RAGPlannerService()
