"""Auth hardening: hashed credentials, cookie + CSRF, startup guard. DB/Redis-free."""
import pytest
from fastapi import FastAPI, Depends
from fastapi.testclient import TestClient

from app.routers import auth
from app.services import ratelimit


@pytest.fixture()
def client(monkeypatch):
    # Rate limiter needs Redis; it fails open, but skip the connect delay.
    monkeypatch.setattr(ratelimit, "_redis", lambda: (_ for _ in ()).throw(RuntimeError("no redis")))
    app = FastAPI()
    app.include_router(auth.router)

    @app.get("/me")
    def me(u=Depends(auth.get_current_user)):
        return u

    @app.post("/write")
    def write(u=Depends(auth.get_current_user)):
        return u

    return TestClient(app)


def _login(c, email="admin@city.gov", pw="demo"):
    return c.post("/api/auth/login", json={"email": email, "password": pw})


def test_no_plaintext_password_in_module():
    assert not any(isinstance(v, dict) and "password" in v for v in vars(auth).values())


def test_login_sets_httponly_cookie(client):
    r = _login(client)
    assert r.status_code == 200
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie


def test_bad_password_rejected(client):
    assert _login(client, pw="nope").status_code == 401
    assert _login(client, email="ghost@x.io").status_code == 401


def test_cookie_read_allowed_write_needs_csrf_header(client):
    _login(client)
    assert client.get("/me").status_code == 200
    assert client.post("/write").status_code == 403
    assert client.post("/write", headers={"X-Requested-With": "x"}).status_code == 200


def test_bearer_needs_no_csrf_header(client):
    token = _login(client).json()["access_token"]
    fresh = TestClient(client.app)
    assert fresh.post("/write", headers={"Authorization": f"Bearer {token}"}).status_code == 200


def test_logout_clears_cookie(client):
    _login(client)
    client.post("/api/auth/logout")
    assert client.get("/me").status_code == 401


def test_insecure_defaults_refused_outside_development(monkeypatch):
    monkeypatch.setattr(auth.settings, "environment", "production")
    with pytest.raises(RuntimeError):
        auth.assert_secure_config()
    monkeypatch.setattr(auth.settings, "jwt_secret", "x" * 40)
    monkeypatch.setattr(auth.settings, "demo_password", "s3cret-pass")
    auth.assert_secure_config()
