"""
Live-update bus for the /ws/live WebSocket.

Publishers and the WebSocket connections don't live in the same process:
`publish_event()` is called from the FastAPI process (e.g. when a complaint is
submitted) and from the Celery worker process (the scheduled camera health
sweep) — separate OS processes that share no memory. Redis pub/sub is the one
thing both already talk to (it's also the Celery broker), so it's the bridge:
publishers push a JSON event onto a channel, and a single background task in
the FastAPI process subscribes and fans it out to every connected socket.

A publish with nobody subscribed is simply dropped. That's correct here: this
is a live-tick feed, not a durable event log — a client that wasn't connected
when a complaint came in doesn't need to be told about it after the fact, its
next poll of GET /api/complaints picks it up anyway.
"""
from __future__ import annotations

import json
import logging

import redis

from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

CHANNEL = "smartcity:live"

_client: redis.Redis | None = None


def _sync_client() -> redis.Redis:
    global _client
    if _client is None:
        _client = redis.Redis.from_url(settings.redis_url)
    return _client


def publish_event(event: dict) -> None:
    """
    Fire-and-forget a live-update event.

    Never let a broadcast failure break the request that triggered it —
    submitting a complaint must succeed even if Redis is briefly unreachable,
    so failures here are logged and swallowed, not raised.
    """
    try:
        _sync_client().publish(CHANNEL, json.dumps(event, default=str))
    except redis.RedisError:
        logger.warning("live event publish failed (Redis unavailable): %s", event.get("type"))
