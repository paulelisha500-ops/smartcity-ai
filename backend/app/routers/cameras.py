"""
M9 — CCTV camera network API.

Governance note that shapes every endpoint here: the platform will not contact
a camera unless its registry row is marked `authorized`. Traffic CCTV in Dubai
is operated by the RTA and in Abu Dhabi by the DMT/ITC; integrating with those
feeds requires a data-sharing agreement and credentials issued by that
authority. This API is the integration — you supply the permission.
"""
import ipaddress
import re
import socket

from fastapi import APIRouter, Depends, HTTPException
from geoalchemy2.shape import to_shape
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.camera import Camera
from app.routers.auth import get_current_user, require_any, ANY_STAFF, OPERATORS
from app.services.camera_link import camera_connector, resolve_secret, apply_probe_result, sweep_fleet

router = APIRouter(prefix="/api/cameras", tags=["cameras"])

# Every endpoint here requires login. Even the read side exposes host/IP and
# protocol detail for infrastructure the platform is trusted to reach — that
# is operational detail, not civic transparency data, so unlike the network
# and infrastructure routers nothing in this module is public. Reads need any
# staff role; anything that contacts a device, stores credentials, or edits
# the registry needs OPERATORS (admin, traffic_officer).


# --------------------------------------------------------------------------
# Schemas
# --------------------------------------------------------------------------

_HOST_RE = re.compile(r"^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$")


def validate_camera_host(host: str) -> str:
    """
    A camera host must be a plain hostname or IP — no whitespace, control
    characters, schemes, paths or ports.

    Hosts are interpolated into rtsp:// and http:// URLs and into raw socket
    requests, so an embedded CR/LF or "/" changes what is sent. (A host of
    "a

b" was previously accepted and stored.)
    """
    host = (host or "").strip()
    if not _HOST_RE.match(host):
        raise ValueError("host must be a hostname or IP address (no spaces, paths, schemes or ports)")
    return host


def assert_not_internal(host: str) -> None:
    """
    Refuse loopback / link-local / metadata addresses for *outbound probes*.

    /cameras/onboard makes the server open a connection to a caller-chosen
    host, which is an SSRF primitive: 169.254.169.254 is the cloud metadata
    service. Private RFC1918 ranges are deliberately still allowed, because
    real CCTV cameras live on private networks.
    """
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return  # unresolvable: the probe itself will report "offline"
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_loopback or ip.is_link_local or ip.is_unspecified or ip.is_multicast or ip.is_reserved:
            raise HTTPException(status_code=400, detail=f"host resolves to a disallowed address ({ip})")


class CameraIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    host: str
    protocol: str = Field("rtsp", pattern="^(rtsp|onvif|http_snapshot)$")
    port: int | None = None
    stream_path: str | None = None
    substream_path: str | None = None
    snapshot_path: str | None = None
    username: str | None = None
    credential_ref: str | None = Field(
        None,
        description="Name of the env var / secret-store entry holding the password. "
                    "Never send the password itself.",
    )
    lat: float | None = Field(None, ge=-90, le=90)
    lon: float | None = Field(None, ge=-180, le=180)
    emirate: str | None = None
    road_ref: str | None = None
    intersection_id: int | None = None
    bearing_deg: float | None = None
    owner_org: str | None = None
    authorized: bool = False
    authorization_ref: str | None = None

    @field_validator("host")
    @classmethod
    def _host_ok(cls, v):
        return validate_camera_host(v)


class OnboardRequest(BaseModel):
    host: str
    port: int = Field(80, ge=1, le=65535)

    @field_validator("host")
    @classmethod
    def _host_ok(cls, v):
        return validate_camera_host(v)

    username: str = ""
    credential_ref: str | None = None


def _out(c: Camera) -> dict:
    lat = lon = None
    if c.geom is not None:
        point = to_shape(c.geom)
        lat, lon = point.y, point.x
    return {
        "id": c.id,
        "name": c.name,
        "lat": lat,
        "lon": lon,
        "emirate": c.emirate,
        "road_ref": c.road_ref,
        "intersection_id": c.intersection_id,
        "bearing_deg": c.bearing_deg,
        "protocol": c.protocol,
        "host": c.host,
        "port": c.port,
        "stream_path": c.stream_path,
        "has_substream": bool(c.substream_path),
        "owner_org": c.owner_org,
        "authorized": bool(c.authorized),
        "authorization_ref": c.authorization_ref,
        "status": c.status,
        "last_seen": c.last_seen.isoformat() if c.last_seen else None,
        "last_error": c.last_error,
        "latency_ms": round(c.latency_ms, 1) if c.latency_ms else None,
        "resolution": c.resolution,
        "codec": c.codec,
        "manufacturer": c.manufacturer,
        "model": c.model,
        "firmware": c.firmware,
        "enabled": bool(c.enabled),
        "credential_configured": bool(resolve_secret(c.credential_ref)),
    }


# --------------------------------------------------------------------------
# CRUD
# --------------------------------------------------------------------------
@router.get("")
def list_cameras(emirate: str | None = None, status: str | None = None,
                 db: Session = Depends(get_db), _user=Depends(require_any(*ANY_STAFF))):
    query = db.query(Camera)
    if emirate:
        query = query.filter(Camera.emirate == emirate)
    if status:
        query = query.filter(Camera.status == status)
    return [_out(c) for c in query.order_by(Camera.id).all()]


@router.post("")
def register_camera(payload: CameraIn, db: Session = Depends(get_db),
                    _user=Depends(require_any(*OPERATORS))):
    """Add a camera to the registry. Registration never contacts the device."""
    data = payload.model_dump()
    lat, lon = data.pop("lat"), data.pop("lon")

    camera = Camera(**data)
    if lat is not None and lon is not None:
        camera.geom = f"SRID=4326;POINT({lon} {lat})"
    db.add(camera)
    db.commit()
    db.refresh(camera)
    return _out(camera)


@router.get("/summary")
def camera_summary(db: Session = Depends(get_db), _user=Depends(require_any(*ANY_STAFF))):
    """Fleet health — the tile the operations console shows."""
    cameras = db.query(Camera).all()
    by_status: dict[str, int] = {}
    by_emirate: dict[str, int] = {}
    for c in cameras:
        by_status[c.status or "unknown"] = by_status.get(c.status or "unknown", 0) + 1
        if c.emirate:
            by_emirate[c.emirate] = by_emirate.get(c.emirate, 0) + 1

    online = by_status.get("online", 0)
    latencies = [c.latency_ms for c in cameras if c.latency_ms]
    return {
        "total": len(cameras),
        "authorized": sum(1 for c in cameras if c.authorized),
        "online": online,
        "availability_pct": round(online / len(cameras) * 100, 1) if cameras else 0.0,
        "by_status": by_status,
        "by_emirate": by_emirate,
        "avg_latency_ms": round(sum(latencies) / len(latencies), 1) if latencies else None,
    }


@router.get("/integration-guide")
def integration_guide(_user=Depends(require_any(*ANY_STAFF))):
    """
    What an operator needs to actually connect this platform to real cameras.
    Served from the API so it shows up in /docs next to the endpoints it explains.
    """
    return {
        "supported_protocols": {
            "rtsp": "RFC 2326 streaming. Give host, port (default 554) and stream path.",
            "onvif": "Profile S. Give host + ONVIF port; the platform discovers "
                     "profiles, stream URI and snapshot URI automatically.",
            "http_snapshot": "Periodic JPEG pull for cameras with no RTSP access.",
        },
        "credentials": {
            "policy": "Passwords are never stored in the database.",
            "how": "Put the password in an environment variable and set the camera's "
                   "credential_ref to that variable's name.",
            "example": "credential_ref='CAM_SZR_01' with env CAM_SZR_01=<password>",
        },
        "authorisation_required": {
            "rule": "The platform refuses to contact a camera unless authorized=true.",
            "dubai": "Traffic CCTV is operated by Dubai's Roads & Transport Authority "
                     "(RTA). Live feed access requires a data-sharing agreement with "
                     "the RTA; open data is published via Dubai Pulse.",
            "abu_dhabi": "Operated by the Department of Municipalities and Transport / "
                         "Integrated Transport Centre.",
            "private": "Mall, campus and logistics-yard cameras need the site owner's "
                       "written permission.",
            "note": "Record the agreement reference in authorization_ref for audit.",
        },
        "open_data_alternative": {
            "dubai_pulse": "https://www.dubaipulse.gov.ae",
            "auth": "OAuth client_credentials; set SMARTCITY_DUBAI_PULSE_KEY and "
                    "SMARTCITY_DUBAI_PULSE_SECRET, then call /api/cameras/open-data/traffic-incidents.",
            "useful_datasets": ["dp_traffic_incidents", "rta_bus_routes", "rta_metro_lines"],
        },
        "performance": {
            "analytics_stream": "Register a substream_path. The CV pipeline uses the "
                                "low-resolution sub-stream — a vehicle is just as "
                                "detectable at 640x480, and decoding 4MP per camera is "
                                "what makes city-scale CV fall over.",
        },
    }


@router.get("/{camera_id}")
def get_camera(camera_id: int, db: Session = Depends(get_db),
               _user=Depends(require_any(*ANY_STAFF))):
    camera = db.get(Camera, camera_id)
    if not camera:
        raise HTTPException(status_code=404, detail="Camera not found")
    return _out(camera)


@router.delete("/{camera_id}")
def delete_camera(camera_id: int, db: Session = Depends(get_db),
                  _user=Depends(require_any(*OPERATORS))):
    camera = db.get(Camera, camera_id)
    if not camera:
        raise HTTPException(status_code=404, detail="Camera not found")
    db.delete(camera)
    db.commit()
    return {"deleted": camera_id}


# --------------------------------------------------------------------------
# Live connectivity
# --------------------------------------------------------------------------
@router.post("/{camera_id}/test")
def test_camera(camera_id: int, db: Session = Depends(get_db),
                _user=Depends(require_any(*OPERATORS))):
    """
    Actually contact the camera: RTSP OPTIONS/DESCRIBE, or an ONVIF
    GetDeviceInformation call. Updates the stored health record.
    """
    camera = db.get(Camera, camera_id)
    if not camera:
        raise HTTPException(status_code=404, detail="Camera not found")

    previous_status = camera.status
    result = camera_connector.test(camera)
    apply_probe_result(camera, result)
    db.commit()

    if result.status != previous_status:
        from app.services.live import publish_event
        publish_event({
            "type": "camera_status", "camera_id": camera.id, "name": camera.name,
            "status": result.status, "emirate": camera.emirate,
        })

    return {
        "camera_id": camera_id,
        "ok": result.ok,
        "status": result.status,
        "latency_ms": round(result.latency_ms, 1) if result.latency_ms else None,
        "codec": result.codec,
        "resolution": result.resolution,
        "error": result.error,
        "detail": result.detail,
        "analytics_stream": camera_connector.analytics_stream_url(camera),
    }


@router.post("/health-sweep")
def health_sweep(limit: int = 50, db: Session = Depends(get_db),
                 _user=Depends(require_any(*OPERATORS))):
    """
    Probe every enabled+authorised camera on demand.

    The same sweep also runs on a schedule via Celery Beat
    (`app.workers.tasks.camera_health_sweep`, every 10 minutes) — that task
    calls `sweep_fleet()` directly rather than this endpoint, since scheduled
    workers run as trusted service code, not as a logged-in operator. This
    endpoint is for "sweep now" from the console.
    """
    return sweep_fleet(db, limit=limit)


@router.post("/onboard")
def onboard_camera(payload: OnboardRequest, _user=Depends(require_any(*OPERATORS))):
    """
    Ask an ONVIF camera to describe itself so an operator only has to type an
    IP address. Returns make/model/firmware plus ready-to-store stream URIs.

    This talks to the host you name — only point it at devices you operate or
    are authorised to access.
    """
    assert_not_internal(payload.host)
    password = resolve_secret(payload.credential_ref) or ""
    if payload.username and not password:
        raise HTTPException(
            status_code=400,
            detail=f"No secret found for credential_ref '{payload.credential_ref}'. "
                   "Set that environment variable on the backend first.",
        )
    return camera_connector.onboard(payload.host, payload.port, payload.username, password)


@router.post("/seed-sites")
def seed_camera_sites(db: Session = Depends(get_db), _user=Depends(require_any(*OPERATORS))):
    """
    Populate the registry with the monitored junctions from the intersection
    dataset, so the fleet view and map are populated before any real camera is
    connected. Sites are created **unauthorised** with no host credentials —
    they are placeholders describing where a camera belongs, not live feeds.
    """
    import json
    from pathlib import Path

    path = Path(__file__).parent.parent / "data" / "mock_intersections.json"
    sites = json.loads(path.read_text())

    existing = {row[0] for row in db.query(Camera.name).all()}
    inserted = 0
    for site in sites:
        name = f"CAM-{site['id']:03d} {site['name']}"
        if name in existing:
            continue
        camera = Camera(
            name=name,
            host="0.0.0.0",  # placeholder until a real device is provisioned
            protocol="rtsp",
            port=554,
            stream_path="/Streaming/Channels/102",
            substream_path="/Streaming/Channels/102",
            emirate=site.get("emirate"),
            road_ref=site.get("road_ref"),
            intersection_id=site["id"],
            owner_org="Not yet provisioned",
            authorized=False,
            status="unknown",
            geom=f"SRID=4326;POINT({site['lon']} {site['lat']})",
        )
        db.add(camera)
        inserted += 1

    db.commit()
    return {
        "sites_created": inserted,
        "total": db.query(Camera).count(),
        "note": "Sites are unauthorised placeholders. Set host, credential_ref, "
                "authorized=true and authorization_ref to connect a real device.",
    }
