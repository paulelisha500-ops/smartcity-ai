"""
The dispatch register and the forecast endpoint, without a database.

Both read from the database when they can and fall back when they cannot, so
the tests stand in a session that either serves fixed rows or fails the way an
unreachable database does.
"""
from types import SimpleNamespace

from fastapi.testclient import TestClient
from geoalchemy2.shape import from_shape
from shapely.geometry import Point
from sqlalchemy.exc import OperationalError

from app.database import get_db
from app.main import app
from app.routers.emergency import FACILITIES, facility_register, responds


class UnreachableSession:
    """Fails every query the way a database that is down does."""

    def query(self, *args, **kwargs):
        raise OperationalError("SELECT 1", {}, Exception("database is down"))

    def close(self):
        pass


class GazetteerSession:
    """Answers place queries with fixed rows, whatever the filter."""

    def __init__(self, rows):
        self.rows = rows

    def query(self, *args, **kwargs):
        return self

    def filter(self, *args, **kwargs):
        return self

    def all(self):
        return self.rows


def place(id_, name, lon, lat, emirate):
    return SimpleNamespace(id=id_, name=name, geom=from_shape(Point(lon, lat), srid=4326), emirate=emirate)


def test_register_uses_the_gazetteer_and_folds_duplicates():
    rows = [
        place(1, "Al Bateen Fire Station", 54.3501, 24.4602, "Abu Dhabi"),
        # OSM maps the same station as an amenity and as a building.
        place(2, "Al Bateen Fire Station", 54.3502, 24.4603, "Abu Dhabi"),
        place(3, "Mussafah Civil Defence", 54.4801, 24.3502, "Abu Dhabi"),
    ]
    register = facility_register(GazetteerSession(rows), "fire")
    assert [f["name"] for f in register] == ["Al Bateen Fire Station", "Mussafah Civil Defence"]
    assert all(f["type"] == "fire" and f["emirate"] == "Abu Dhabi" for f in register)
    assert register[0]["id"] == "osm-1"
    assert abs(register[0]["lat"] - 24.4602) < 1e-9 and abs(register[0]["lon"] - 54.3501) < 1e-9


def test_register_falls_back_when_the_gazetteer_is_empty_or_unreachable():
    for session in (GazetteerSession([]), UnreachableSession()):
        register = facility_register(session, "police")
        assert register == [f for f in FACILITIES if f["type"] == "police"]


def test_only_response_stations_are_dispatch_candidates():
    assert responds("fire", "Khalifa City Fire Station")
    assert responds("fire", "Civil Defence Station Al Karama")
    assert responds("fire", "مركز الدفاع المدني")
    assert not responds("fire", "Fire Fighting and Safety CO")
    assert not responds("fire", "DWC Fire Training Ground")
    assert not responds("fire", "Al Ain Power Station")
    assert responds("police", "Khaldiah police station")
    assert responds("police", "مركز شرطة مسيعيد")
    assert not responds("police", "Abu Dhabi Police College")
    assert not responds("police", "Traffic Fine Department")
    assert responds("hospital", "Rashid Hospital")


def test_unknown_service_has_no_facilities():
    assert facility_register(GazetteerSession([place(1, "X", 55.0, 25.0, "Dubai")]), "lifeguard") == []


client = TestClient(app)  # no `with`: skips startup (no DB/Redis needed)


def test_forecast_without_history_uses_the_typical_pattern():
    app.dependency_overrides[get_db] = lambda: UnreachableSession()
    try:
        res = client.get("/api/prediction/intersection/3?horizon_hours=24")
    finally:
        app.dependency_overrides.pop(get_db, None)
    assert res.status_code == 200
    body = res.json()
    assert body["basis"] == "typical_pattern" and body["history_points"] == 0
    assert len(body["forecast"]) == 24
    for point in body["forecast"]:
        assert point["confidence_low"] <= point["predicted_congestion_score"] <= point["confidence_high"]


def test_forecast_uses_stored_history():
    from datetime import datetime, timedelta

    now = datetime.utcnow()
    rows = [(now - timedelta(days=d, hours=h), 80.0 if h % 2 else 20.0) for d in range(1, 8) for h in range(24)]
    app.dependency_overrides[get_db] = lambda: GazetteerSession(rows)
    try:
        body = client.get("/api/prediction/intersection/3?horizon_hours=6").json()
    finally:
        app.dependency_overrides.pop(get_db, None)
    assert body["basis"] == "history" and body["history_points"] == len(rows)
    assert len(body["forecast"]) == 6
    assert {p["predicted_congestion_score"] for p in body["forecast"]} <= {20.0, 80.0}


def test_forecast_horizon_is_bounded():
    assert client.get("/api/prediction/intersection/3?horizon_hours=0").status_code == 422
    assert client.get("/api/prediction/intersection/3?horizon_hours=169").status_code == 422
