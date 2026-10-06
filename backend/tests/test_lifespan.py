"""
Startup and shutdown, with the database and Redis stood in.

The other suites use TestClient without `with`, which skips the lifespan; this
one runs it, so a broken startup fails CI rather than the first deployment.
"""
import asyncio

from fastapi.testclient import TestClient

import app.main as main


def test_startup_prepares_the_database_and_starts_and_stops_the_background_tasks(monkeypatch):
    started = {"subscriber": False, "warm": False}
    cancelled = {"subscriber": False, "warm": False}

    def runs_until_cancelled(name):
        async def task():
            started[name] = True
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled[name] = True
                raise
        return task

    monkeypatch.setattr(main, "init_db", lambda: True)
    monkeypatch.setattr(main, "_redis_subscriber", runs_until_cancelled("subscriber"))
    monkeypatch.setattr(main, "_warm_routing_graph", runs_until_cancelled("warm"))

    with TestClient(main.app) as client:
        assert client.get("/health").json()["database"] == "ready"
        assert all(started.values())
    assert all(cancelled.values())


def test_startup_reports_an_unreachable_database(monkeypatch):
    async def idle():
        await asyncio.Event().wait()

    monkeypatch.setattr(main, "init_db", lambda: False)
    monkeypatch.setattr(main, "_redis_subscriber", idle)
    monkeypatch.setattr(main, "_warm_routing_graph", idle)

    with TestClient(main.app) as client:
        body = client.get("/health").json()
    assert body["status"] == "healthy" and body["database"] == "unavailable"
