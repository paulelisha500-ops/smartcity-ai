import asyncio
import json
import logging
import random
from pathlib import Path

import redis.asyncio as aioredis
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.routers.auth import assert_secure_config
from app.database import init_db
from app.routers import (
    traffic, road_damage, complaints, prediction, planner, digital_twin,
    emergency, analytics, auth,
    cameras, network, infrastructure, route_design, places,
)
from app.services.live import CHANNEL

logger = logging.getLogger(__name__)

settings = get_settings()

app = FastAPI(
    title=settings.app_name,
    description="Intelligent Urban Planning & Traffic Management Platform — POC API",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(traffic.router)
app.include_router(road_damage.router)
app.include_router(complaints.router)
app.include_router(prediction.router)
app.include_router(planner.router)
app.include_router(digital_twin.router)
app.include_router(emergency.router)
app.include_router(analytics.router)
# Modules 9-12
app.include_router(cameras.router)
app.include_router(network.router)
app.include_router(infrastructure.router)
app.include_router(route_design.router)
app.include_router(places.router)


MODULES = [
    {"id": 1,  "name": "Smart Traffic Analysis",       "prefix": "/api/traffic"},
    {"id": 2,  "name": "Road Damage Detection",        "prefix": "/api/road-damage"},
    {"id": 3,  "name": "Citizen Complaint Analysis",   "prefix": "/api/complaints"},
    {"id": 4,  "name": "Smart Traffic Prediction",     "prefix": "/api/prediction"},
    {"id": 5,  "name": "AI City Planner (RAG)",        "prefix": "/api/planner"},
    {"id": 6,  "name": "Digital Twin Dashboard",       "prefix": "/api/digital-twin"},
    {"id": 7,  "name": "Emergency Routing",            "prefix": "/api/emergency"},
    {"id": 8,  "name": "Government Analytics / KPIs",  "prefix": "/api/analytics"},
    {"id": 9,  "name": "CCTV Camera Network",          "prefix": "/api/cameras"},
    {"id": 10, "name": "UAE Road Network & Borders",   "prefix": "/api/network"},
    {"id": 11, "name": "Infrastructure & Bridges",     "prefix": "/api/infrastructure"},
    {"id": 12, "name": "New Route Design",             "prefix": "/api/route-design"},
]


@app.on_event("startup")
def on_startup():
    """
    Prepare the database. `init_db` retries on a bounded budget and returns
    False rather than blocking forever, so a bad DSN surfaces as a failing
    endpoint with a log line instead of a server that never finishes booting.
    """
    assert_secure_config()  # raises outside development with default secrets
    app.state.db_ready = init_db()
    # Reference kept on app.state so the task isn't garbage-collected — asyncio
    # only holds a weak reference to a task once nothing else points at it.
    app.state.live_subscriber_task = asyncio.create_task(_redis_subscriber())
    app.state.graph_warm_task = asyncio.create_task(_warm_routing_graph())


async def _warm_routing_graph():
    """
    Build the routing graph in the background at boot.

    The first route request after a restart otherwise pays the whole graph
    build (~1 minute for 170k links) inside the HTTP request, which is what
    made the first corridor analysis or dispatch lookup look hung. Runs in a
    worker thread so it never blocks the event loop; failures are logged only —
    the graph is still built lazily on first use.
    """
    def build():
        from app.database import SessionLocal
        from app.services.road_graph import graph_cache
        db = SessionLocal()
        try:
            graph_cache.get(db)
        finally:
            db.close()
    try:
        await asyncio.to_thread(build)
    except Exception:
        logger.warning("routing graph warm-up failed; it will build on first request", exc_info=True)


@app.on_event("shutdown")
async def on_shutdown():
    task = getattr(app.state, "live_subscriber_task", None)
    if task:
        task.cancel()


@app.get("/")
def root():
    return {
        "service": settings.app_name,
        "version": app.version,
        "model_mode": settings.model_mode,
        "modules": MODULES,
        "docs": "/docs",
    }


@app.get("/health")
def health():
    return {
        "status": "healthy",
        "database": "ready" if getattr(app.state, "db_ready", False) else "unavailable",
        "model_mode": settings.model_mode,
    }


try:
    _INTERSECTIONS = json.loads(
        (Path(__file__).parent / "data" / "mock_intersections.json").read_text()
    )
except Exception:
    _INTERSECTIONS = []


class ConnectionManager:
    """
    One asyncio.Queue per connection, rather than writing to the socket
    directly from `broadcast()`.

    Two independent sources feed each connection: the per-socket synthetic
    congestion ticker below, and the single global Redis-subscriber task
    forwarding real events (new complaints, camera status changes) to every
    socket. If both wrote to the same WebSocket concurrently, ASGI gives no
    guarantee their frames don't interleave mid-write. Routing everything
    through a queue means each connection has exactly one writer — the loop
    in `live_updates` — so there's one place messages are ever sent from.
    """

    def __init__(self):
        self.queues: dict[WebSocket, asyncio.Queue] = {}

    async def connect(self, ws: WebSocket) -> asyncio.Queue:
        await ws.accept()
        queue: asyncio.Queue = asyncio.Queue(maxsize=50)
        self.queues[ws] = queue
        return queue

    def disconnect(self, ws: WebSocket):
        self.queues.pop(ws, None)

    async def broadcast(self, message: dict):
        for queue in list(self.queues.values()):
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                # A slow/stalled client falls behind rather than blocking
                # every other connection — this is a live tick feed, not a
                # guaranteed-delivery log, so dropping the oldest interest is
                # the wrong tradeoff; dropping the newest tick is fine.
                pass


manager = ConnectionManager()


async def _redis_subscriber():
    """
    Bridges Redis pub/sub (see app/services/live.py) into every open
    WebSocket connection.

    Runs once for the whole process, started at app startup. Publishers live
    in two different OS processes — this FastAPI process (e.g. complaint
    submission) and the Celery worker (the scheduled camera health-sweep) —
    so an in-memory broadcast alone could never reach events from the worker;
    Redis is the bridge both already share.
    """
    settings = get_settings()
    backoff = 1.0
    while True:
        try:
            client = aioredis.Redis.from_url(settings.redis_url)
            pubsub = client.pubsub()
            await pubsub.subscribe(CHANNEL)
            backoff = 1.0
            async for raw in pubsub.listen():
                if raw.get("type") != "message":
                    continue
                try:
                    event = json.loads(raw["data"])
                except (TypeError, ValueError):
                    continue
                await manager.broadcast(event)
        except asyncio.CancelledError:
            raise
        except Exception:
            # Redis restarting, network blip, etc. Reconnect rather than let
            # the whole live-update feed die silently for the app's lifetime.
            logger.warning("live_subscriber: Redis connection lost, retrying in %.0fs", backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30.0)


@app.websocket("/ws/live")
async def live_updates(websocket: WebSocket):
    """
    Pushes live updates to every connected dashboard: a synthetic congestion
    tick every 5s (mock mode — in production this is real CV inference
    output), plus real events as they happen — new complaints, camera status
    changes — forwarded from Redis by `_redis_subscriber`.
    """
    queue = await manager.connect(websocket)

    async def synthetic_ticker():
        while True:
            await asyncio.sleep(5)
            if not _INTERSECTIONS:
                continue
            spot = random.choice(_INTERSECTIONS)
            try:
                queue.put_nowait({
                    "type": "congestion_update",
                    "intersection_id": spot["id"],
                    "intersection_name": spot["name"],
                    "congestion_score": round(random.uniform(20, 95), 1),
                })
            except asyncio.QueueFull:
                pass

    ticker_task = asyncio.create_task(synthetic_ticker())
    try:
        while True:
            message = await queue.get()
            await websocket.send_json(message)
    except WebSocketDisconnect:
        pass
    finally:
        ticker_task.cancel()
        manager.disconnect(websocket)