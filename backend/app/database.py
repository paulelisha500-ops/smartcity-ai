import logging
import time

from sqlalchemy import create_engine, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import sessionmaker, declarative_base

from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

engine = create_engine(
    settings.postgres_url,
    pool_pre_ping=True,
    # A small pool keeps memory predictable on a laptop while still serving
    # the dashboard's parallel fetches comfortably.
    pool_size=5,
    max_overflow=5,
    pool_recycle=1800,
    # jit=off: Postgres JIT-compiles any query it costs as expensive, and on the
    # spatial queries here compilation (~280 ms) exceeds the run time it saves.
    # statement_timeout: a runaway query must fail, not hold a pool connection.
    connect_args={"connect_timeout": 10, "options": "-c jit=off -c statement_timeout=120000"},
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db(max_attempts: int = 10, delay_s: float = 3.0) -> bool:
    """
    Enable PostGIS and create any missing tables.

    Retries with a bounded budget rather than blocking forever: on a cold
    `docker compose up`, Postgres is still starting when the API boots, but an
    unbounded wait turns a misconfigured DSN into a server that hangs with no
    explanation. After `max_attempts` we log loudly and let the app start —
    /health stays up so the container is debuggable.
    """
    import app.models  # noqa: F401 — registers every model on Base before create_all

    for attempt in range(1, max_attempts + 1):
        try:
            with engine.connect() as conn:
                conn.execute(text("CREATE EXTENSION IF NOT EXISTS postgis"))
                # pg_trgm powers fuzzy place search: it makes `%` similarity
                # and ILIKE '%term%' index-backed, so the geocoder stays fast
                # and tolerates the spelling variation that is unavoidable
                # with transliterated Arabic names (Al Maktoum / Al-Maktoum).
                conn.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))
                conn.commit()
            Base.metadata.create_all(bind=engine)

            # create_all only builds indexes for tables it creates, so indexes
            # added to an existing model would otherwise never appear. These
            # are declared IF NOT EXISTS and are cheap to re-issue on boot.
            with engine.connect() as conn:
                conn.execute(text(
                    "CREATE INDEX IF NOT EXISTS ix_place_name_trgm "
                    "ON gazetteer_place USING gin (name gin_trgm_ops)"
                ))
                conn.execute(text(
                    "CREATE UNIQUE INDEX IF NOT EXISTS uq_place_osm "
                    "ON gazetteer_place (osm_type, osm_id) WHERE osm_id IS NOT NULL"
                ))
                conn.commit()

            logger.info("Database ready (attempt %s)", attempt)
            return True
        except OperationalError as exc:
            logger.warning(
                "Database not ready (attempt %s/%s): %s", attempt, max_attempts, exc
            )
            if attempt == max_attempts:
                logger.error(
                    "Giving up on DB init. The API will start but database-backed "
                    "endpoints will fail until Postgres is reachable."
                )
                return False
            time.sleep(delay_s)
        except Exception:
            logger.exception("Unexpected error during database initialisation")
            return False
    return False
