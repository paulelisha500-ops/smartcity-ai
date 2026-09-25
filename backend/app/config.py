from functools import lru_cache
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """
    Central config. Every AI service checks `model_mode` to decide whether to
    run its mock implementation or call the real model. This is what lets the
    exact same codebase run as a zero-dependency demo today and a real
    production system later, just by changing env vars.
    """

    app_name: str = "SmartCity AI"
    environment: str = "development"

    # mock  -> deterministic, demo-safe, no GPU/API key required
    # production -> real model calls (YOLO, LangChain+LLM, trained forecasters)
    model_mode: str = "mock"

    postgres_url: str = "postgresql://smartcity:smartcity@postgres:5432/smartcity"
    mongo_url: str = "mongodb://mongo:27017"
    redis_url: str = "redis://redis:6379/0"

    jwt_secret: str = "change-me-in-production"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 60 * 8
    # Password for the built-in demo accounts. The default is only accepted in
    # development; any other environment must set its own (see routers/auth.py).
    demo_password: str = "demo"
    # Trust X-Forwarded-For for client IPs (set only behind your own proxy).
    trust_proxy_headers: bool = False
    cookie_samesite: str = "lax"

    # LLM/RAG (only used when model_mode == "production")
    llm_provider: str = "anthropic"
    llm_model: str = "claude-sonnet-4-6"

    cors_origins: list[str] = ["http://localhost:3000", "http://localhost:3001"]

    # --- M10: UAE road network ingestion (OpenStreetMap / Overpass) ---------
    # Overpass is a free, public read-only API over live OSM data. We pull the
    # real UAE highway network from it once and persist geometry into PostGIS.
    overpass_url: str = "https://overpass-api.de/api/interpreter"
    overpass_timeout_s: int = 180
    # UAE bounding box (south, west, north, east) — covers all seven emirates
    # plus the border approaches to Oman and Saudi Arabia.
    uae_bbox: tuple[float, float, float, float] = (22.5, 51.0, 26.5, 56.5)

    # --- M9: CCTV camera network -------------------------------------------
    # Connection probing is done with raw RTSP/ONVIF over the network. These
    # are *client* settings — the platform never stores plaintext camera
    # passwords in the DB, only a reference to a secret (see camera model).
    camera_connect_timeout_s: float = 6.0
    camera_snapshot_timeout_s: float = 10.0
    camera_default_rtsp_port: int = 554
    camera_default_onvif_port: int = 80
    # Set true only on a network where you are authorised to enumerate devices.
    camera_discovery_enabled: bool = False

    # --- Dubai Pulse open-data (real RTA/Dubai government traffic feeds) ----
    # Credentials are issued per-account by Dubai Pulse; without them the
    # connector reports "not configured" rather than failing the app.
    dubai_pulse_auth_url: str = (
        "https://api.dubaipulse.gov.ae/oauth/client_credential/accesstoken"
        "?grant_type=client_credentials"
    )
    dubai_pulse_base_url: str = "https://api.dubaipulse.gov.ae"
    dubai_pulse_key: str = ""
    dubai_pulse_secret: str = ""

    class Config:
        env_prefix = "SMARTCITY_"
        env_file = ".env"


@lru_cache
def get_settings() -> Settings:
    return Settings()
