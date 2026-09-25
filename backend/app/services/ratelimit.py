"""
Per-client rate limiting for the endpoints anyone can call without logging in.

Fixed-window counter in Redis (INCR + EXPIRE): one round trip, no new
dependency, and shared across API workers. It fails *open* — if Redis is
unreachable the request is allowed — because the limiter protects the
service from abuse; it must never be the reason a citizen can't file a
complaint.
"""
from __future__ import annotations

import logging

import redis
from fastapi import HTTPException, Request

from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

_client: redis.Redis | None = None


def _redis() -> redis.Redis:
    global _client
    if _client is None:
        _client = redis.Redis.from_url(
            settings.redis_url, socket_timeout=0.5, socket_connect_timeout=0.5
        )
    return _client


def client_ip(request: Request) -> str:
    # Behind a reverse proxy the socket peer is the proxy, so honour the first
    # X-Forwarded-For hop when one is configured to be trusted.
    if settings.trust_proxy_headers:
        fwd = request.headers.get("x-forwarded-for")
        if fwd:
            return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def rate_limit(bucket: str, limit: int, window_s: int = 60):
    """FastAPI dependency: at most `limit` calls per `window_s` per client IP."""

    def _dependency(request: Request):
        key = f"smartcity:rl:{bucket}:{client_ip(request)}"
        try:
            r = _redis()
            count = r.incr(key)
            if count == 1:
                r.expire(key, window_s)
            if count > limit:
                ttl = r.ttl(key)
                raise HTTPException(
                    status_code=429,
                    detail=f"Too many requests. Try again in {max(ttl, 1)} seconds.",
                    headers={"Retry-After": str(max(ttl, 1))},
                )
        except HTTPException:
            raise
        except Exception as exc:  # Redis down: fail open
            logger.warning("Rate limiter unavailable (%s); allowing request", exc)

    return _dependency
