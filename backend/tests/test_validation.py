"""
Regression tests for the input-validation fixes from the QA audit.

None of these need a database: every case is rejected (422/400/401) by request
validation or a pure function before any query runs, so they are safe and fast
to run in CI.
"""
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.main import app
from app.routers.cameras import CameraIn, OnboardRequest, validate_camera_host, assert_not_internal
from app.routers.route_design import DesignRequest
from app.schemas.complaint import ComplaintIn

client = TestClient(app)  # no `with`: skips startup (no DB/Redis needed)


# ---- complaints ----------------------------------------------------------
@pytest.mark.parametrize("text", ["", "abcd", "     ", "a" * 2001])
def test_complaint_text_rejected(text):
    with pytest.raises(ValidationError):
        ComplaintIn(text=text)


@pytest.mark.parametrize("kw", [{"lat": 999, "lon": 10}, {"lat": 10, "lon": 999}, {"lat": 10}, {"lon": 10}])
def test_complaint_coordinates_rejected(kw):
    with pytest.raises(ValidationError):
        ComplaintIn(text="pothole near school", **kw)


def test_complaint_valid_and_trimmed():
    c = ComplaintIn(text="  pothole near school  ", lat=25.2, lon=55.3)
    assert c.text == "pothole near school"


def test_complaint_endpoint_422():
    assert client.post("/api/complaints", json={"text": "abcd"}).status_code == 422
    assert client.post("/api/complaints", json={"text": "pothole here", "lat": 999, "lon": 999}).status_code == 422


# ---- route design --------------------------------------------------------
@pytest.mark.parametrize("bad", [
    {"origin_lat": 999}, {"origin_lon": 999}, {"dest_lat": -91}, {"lanes": -5}, {"lanes": 99},
])
def test_design_request_rejected(bad):
    base = dict(origin_lat=25.2, origin_lon=55.3, dest_lat=25.3, dest_lon=55.4)
    with pytest.raises(ValidationError):
        DesignRequest(**{**base, **bad})


# ---- camera hosts / SSRF -------------------------------------------------
@pytest.mark.parametrize("host", ["a\r\nb", "h/evil", "host name", "rtsp://x", "x:554", "", "a" * 300])
def test_camera_host_rejected(host):
    with pytest.raises(ValueError):
        validate_camera_host(host)


@pytest.mark.parametrize("host", ["10.0.0.5", "cam-01.example.com", "192.168.1.20"])
def test_camera_host_accepted(host):
    assert validate_camera_host(host) == host


@pytest.mark.parametrize("host", ["127.0.0.1", "169.254.169.254", "0.0.0.0"])
def test_internal_hosts_blocked_for_probes(host):
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as e:
        assert_not_internal(host)
    assert e.value.status_code == 400


def test_camera_models_validate_hosts_and_ports():
    with pytest.raises(ValidationError):
        CameraIn(name="x", host="a\r\nb")
    with pytest.raises(ValidationError):
        CameraIn(name="", host="10.0.0.5")
    with pytest.raises(ValidationError):
        OnboardRequest(host="10.0.0.5", port=99999)


# ---- query params and auth ----------------------------------------------
@pytest.mark.parametrize("url", [
    "/api/network/roads?bbox=a,b,c,d",
    "/api/network/roads?bbox=30,60,20,50",
    "/api/places/reverse?lat=999&lon=1",
    "/api/places/search?q=a",
    "/api/emergency/nearest-facility?lat=999&lon=1",
    "/api/analytics/history/congestion?hours=0",
])
def test_bad_query_params_rejected(url):
    assert client.get(url).status_code in (400, 422)


@pytest.mark.parametrize("method,url", [
    ("get", "/api/cameras"), ("get", "/api/complaints"),
    ("post", "/api/infrastructure/seed"), ("post", "/api/network/ingest"),
    ("post", "/api/cameras/onboard"), ("patch", "/api/complaints/1/status?status=resolved"),
])
def test_protected_endpoints_require_login(method, url):
    assert getattr(client, method)(url).status_code in (401, 422)


def test_forged_tokens_rejected():
    for tok in ("abc", "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJ4Iiwicm9sZSI6ImFkbWluIn0."):
        assert client.get("/api/cameras", headers={"Authorization": f"Bearer {tok}"}).status_code == 401
