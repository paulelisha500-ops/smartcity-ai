import hashlib
import hmac
import os
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.security import OAuth2PasswordBearer
from jose import jwt, JWTError
from pydantic import BaseModel

from app.config import get_settings
from app.services.ratelimit import rate_limit

router = APIRouter(prefix="/api/auth", tags=["auth"])
settings = get_settings()
# auto_error=False: the session normally arrives as an httpOnly cookie, and
# the Bearer header stays supported for scripts and API clients.
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)

COOKIE_NAME = "smartcity_session"
CSRF_HEADER = "x-requested-with"
_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}

ROLES = {"admin", "traffic_officer", "city_planner", "maintenance_department", "public_user"}

_DEFAULT_SECRET = "change-me-in-production"
_DEFAULT_PASSWORD = "demo"


def _hash(password: str, salt: bytes) -> bytes:
    return hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)


# Demo accounts. The shared password comes from SMARTCITY_DEMO_PASSWORD and is
# held only as a salted scrypt hash, never as plaintext. Production replaces
# this table with the authority's SSO/identity provider.
_SALT = os.urandom(16)
_DEMO_ROLES = {
    "admin@city.gov": "admin",
    "officer@city.gov": "traffic_officer",
    "planner@city.gov": "city_planner",
    "maintenance@city.gov": "maintenance_department",
    "citizen@example.com": "public_user",
}
_DEMO_HASH = _hash(settings.demo_password, _SALT)


def assert_secure_config() -> None:
    """Refuse to start outside development with the shipped default secrets."""
    if settings.environment == "development":
        return
    problems = []
    if settings.jwt_secret == _DEFAULT_SECRET or len(settings.jwt_secret) < 32:
        problems.append("SMARTCITY_JWT_SECRET must be a random value of 32+ characters")
    if settings.demo_password == _DEFAULT_PASSWORD:
        problems.append("SMARTCITY_DEMO_PASSWORD must not be the default")
    if problems:
        raise RuntimeError(
            f"Insecure configuration for environment '{settings.environment}': " + "; ".join(problems)
        )


class LoginRequest(BaseModel):
    email: str
    password: str


@router.post("/login", dependencies=[Depends(rate_limit("login", 10, 60))])
def login(payload: LoginRequest, response: Response):
    role = _DEMO_ROLES.get(payload.email)
    # Hash and compare even for unknown emails so response time doesn't reveal
    # which accounts exist.
    candidate = _hash(payload.password, _SALT)
    if not role or not hmac.compare_digest(candidate, _DEMO_HASH):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    expire = datetime.utcnow() + timedelta(minutes=settings.jwt_expire_minutes)
    token = jwt.encode(
        {"sub": payload.email, "role": role, "exp": expire},
        settings.jwt_secret,
        algorithm=settings.jwt_algorithm,
    )
    response.set_cookie(
        COOKIE_NAME,
        token,
        max_age=settings.jwt_expire_minutes * 60,
        httponly=True,  # page scripts cannot read it, so XSS can't steal the session
        secure=settings.environment != "development",
        samesite=settings.cookie_samesite,
        path="/",
    )
    # The token is also returned for API/script clients; the browser console
    # ignores it and relies on the cookie.
    return {
        "access_token": token,
        "token_type": "bearer",
        "role": role,
        "email": payload.email,
        "expires_at": int((expire - datetime(1970, 1, 1)).total_seconds()),
    }


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}


def get_current_user(request: Request, bearer: str | None = Depends(oauth2_scheme)):
    token = bearer
    from_cookie = False
    if not token:
        token = request.cookies.get(COOKIE_NAME)
        from_cookie = token is not None
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated",
                            headers={"WWW-Authenticate": "Bearer"})

    # CSRF: browsers attach cookies to cross-site requests automatically, so a
    # state-changing request authenticated *by cookie* must also carry a custom
    # header. A cross-origin page can't set one without a CORS preflight, which
    # our origin allow-list refuses. Bearer-authenticated calls are immune.
    if from_cookie and request.method not in _SAFE_METHODS and not request.headers.get(CSRF_HEADER):
        raise HTTPException(status_code=403, detail="Missing CSRF header")

    try:
        data = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
        return {"email": data["sub"], "role": data["role"]}
    except (JWTError, KeyError):
        raise HTTPException(status_code=401, detail="Invalid or expired token")


def require_role(*allowed_roles: str):
    def _dependency(user=Depends(get_current_user)):
        if user["role"] not in allowed_roles:
            raise HTTPException(status_code=403, detail="Insufficient role for this action")
        return user
    return _dependency


# --- Reusable role groups --------------------------------------------------
# Named here rather than repeated per router, so the actual permission model
# lives in one place. `require_any()` gates state-changing or operationally
# sensitive endpoints; anything without a Depends(...) is deliberately public
# (the read-only civic data — live traffic, KPIs, infrastructure projects,
# road network — that a government transparency dashboard is expected to
# expose without a login).
ANY_STAFF = ("admin", "traffic_officer", "city_planner", "maintenance_department")
OPERATORS = ("admin", "traffic_officer")       # camera fleet, emergency dispatch
PLANNERS = ("admin", "city_planner")           # network/place ingestion, infra register
MAINTAINERS = ("admin", "maintenance_department", "traffic_officer")  # complaint routing


def require_any(*allowed_roles: str):
    """Alias of require_role with a name that reads better at call sites."""
    return require_role(*allowed_roles)


# For 'must be logged in, any role' call sites: Depends(get_current_user) directly.
