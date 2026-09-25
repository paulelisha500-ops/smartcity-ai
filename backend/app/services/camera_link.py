"""
M9 — CCTV camera link layer.

This is a *real* camera client, not a mock. It speaks the two protocols that
actually matter for traffic CCTV:

  * **RTSP** (RFC 2326) — implemented directly over a TCP socket. We run the
    real `OPTIONS` → `DESCRIBE` handshake, handle Basic and Digest auth
    challenges, and parse the returned SDP to learn the codec and resolution
    the camera is really serving. No ffmpeg, no OpenCV — which keeps the
    container small enough to run on a laptop.
  * **ONVIF** (Profile S) — a SOAP/HTTP API. We POST hand-built envelopes with
    a WS-Security UsernameToken (PasswordDigest) header to read device
    information, enumerate media profiles, and resolve the stream and snapshot
    URIs. Again no SDK: three small XML templates cover what a traffic
    deployment needs.

Design notes that matter in production:

  * **Sub-stream for analytics.** Decoding a 4MP main stream to count cars
    wastes CPU for no accuracy gain, so `analytics_stream_url()` prefers the
    camera's low-res sub-stream and falls back to the main stream.
  * **No plaintext secrets in the DB.** `Camera.credential_ref` names an entry
    in the deployment secret store; `resolve_secret()` reads it at call time.
  * **Authorisation is enforced, not assumed.** A camera is only contacted when
    `authorized=True`. Connecting to cameras you do not operate — including
    government traffic CCTV — requires a data-sharing agreement with the
    operating authority (in Dubai, the RTA). This module gives you the
    integration; you supply the permission and the credentials.
"""
from __future__ import annotations

import base64
import hashlib
import os
import re
import secrets
import socket
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urlparse

import httpx

from app.config import get_settings

settings = get_settings()


# --------------------------------------------------------------------------
# Secrets
# --------------------------------------------------------------------------
def resolve_secret(credential_ref: Optional[str]) -> Optional[str]:
    """
    Resolve a camera password from the deployment secret store.

    The POC backend reads environment variables, which is what a container
    orchestrator injects from Vault/Secrets Manager anyway. `credential_ref`
    is the *name*, never the value — so the database can be dumped, shared or
    backed up without leaking camera credentials.
    """
    if not credential_ref:
        return None
    return os.environ.get(credential_ref) or os.environ.get(
        f"SMARTCITY_CAMERA_SECRET_{credential_ref}"
    )


@dataclass
class ProbeResult:
    """What we learned by actually talking to a camera."""

    ok: bool
    status: str                       # online | offline | unauthorized | forbidden
    latency_ms: Optional[float] = None
    codec: Optional[str] = None
    resolution: Optional[str] = None
    error: Optional[str] = None
    detail: dict = field(default_factory=dict)


# --------------------------------------------------------------------------
# HTTP Digest / Basic helpers (shared by RTSP and ONVIF snapshot fetch)
# --------------------------------------------------------------------------
def _parse_auth_challenge(header: str) -> dict:
    """Parse a WWW-Authenticate header into its key/value parameters."""
    params = dict(re.findall(r'(\w+)\s*=\s*"([^"]*)"', header))
    if "algorithm" not in params:
        m = re.search(r"algorithm\s*=\s*([\w-]+)", header)
        if m:
            params["algorithm"] = m.group(1)
    return params


def _digest_response(
    username: str, password: str, realm: str, nonce: str, method: str, uri: str,
    qop: str = "", cnonce: str = "", nc: str = "",
) -> str:
    """
    Compute a Digest `response` value.

    Two forms exist and cameras use both:

    * **RFC 2069** (no `qop`): `MD5(HA1:nonce:HA2)` — older/simpler firmware.
    * **RFC 2617** (`qop="auth"`): `MD5(HA1:nonce:nc:cnonce:qop:HA2)` — what
      most current IP cameras challenge with.

    Sending the qop-less response to a server that asked for `qop=auth` gets
    rejected, which surfaces as a false "bad credentials" — so we honour
    whichever form the challenge specified.
    """
    ha1 = hashlib.md5(f"{username}:{realm}:{password}".encode()).hexdigest()
    ha2 = hashlib.md5(f"{method}:{uri}".encode()).hexdigest()
    if qop:
        return hashlib.md5(
            f"{ha1}:{nonce}:{nc}:{cnonce}:{qop}:{ha2}".encode()
        ).hexdigest()
    return hashlib.md5(f"{ha1}:{nonce}:{ha2}".encode()).hexdigest()


def build_digest_header(challenge: str, username: str, password: str,
                        method: str, uri: str) -> str:
    """Build a complete `Authorization: Digest ...` header from a challenge."""
    p = _parse_auth_challenge(challenge)
    realm = p.get("realm", "")
    nonce = p.get("nonce", "")
    opaque = p.get("opaque")

    # A server may offer several qop values ("auth,auth-int"); we implement
    # "auth". auth-int additionally hashes the body, which RTSP control
    # requests don't have, so it is not worth supporting here.
    offered = [q.strip() for q in p.get("qop", "").split(",") if q.strip()]
    use_qop = "auth" if "auth" in offered else ""

    cnonce = secrets.token_hex(8) if use_qop else ""
    nc = "00000001" if use_qop else ""

    response = _digest_response(
        username, password, realm, nonce, method, uri,
        qop=use_qop, cnonce=cnonce, nc=nc,
    )

    parts = [
        f'username="{username}"',
        f'realm="{realm}"',
        f'nonce="{nonce}"',
        f'uri="{uri}"',
        f'response="{response}"',
    ]
    if use_qop:
        parts += [f"qop={use_qop}", f"nc={nc}", f'cnonce="{cnonce}"']
    if opaque:
        parts.append(f'opaque="{opaque}"')
    return "Digest " + ", ".join(parts)


def _basic_header(username: str, password: str) -> str:
    token = base64.b64encode(f"{username}:{password}".encode()).decode()
    return f"Basic {token}"


# --------------------------------------------------------------------------
# RTSP
# --------------------------------------------------------------------------
class RTSPProbe:
    """
    Minimal RTSP client that performs a genuine OPTIONS/DESCRIBE exchange.

    We deliberately stop at DESCRIBE: it proves the camera is reachable,
    that the credentials are accepted, and that the requested stream path
    exists — and it tells us the codec/resolution from the SDP — without
    setting up an RTP session or pulling any video. That makes health checks
    cheap enough to run across thousands of cameras on a schedule.
    """

    def __init__(self, timeout: Optional[float] = None):
        self.timeout = timeout or settings.camera_connect_timeout_s

    def probe(self, url: str, username: Optional[str], password: Optional[str]) -> ProbeResult:
        parsed = urlparse(url)
        if parsed.scheme != "rtsp":
            return ProbeResult(False, "offline", error=f"not an rtsp url: {url}")

        host = parsed.hostname
        port = parsed.port or settings.camera_default_rtsp_port
        if not host:
            return ProbeResult(False, "offline", error="missing host in rtsp url")

        started = time.perf_counter()
        sock = None
        try:
            sock = socket.create_connection((host, port), timeout=self.timeout)
            sock.settimeout(self.timeout)

            # --- OPTIONS: does anything speak RTSP here? -------------------
            options = self._request(sock, "OPTIONS", url, seq=1)
            if not options:
                return ProbeResult(False, "offline", error="no RTSP response to OPTIONS")

            # --- DESCRIBE: does this stream exist, and may we have it? -----
            describe = self._request(
                sock, "DESCRIBE", url, seq=2, extra="Accept: application/sdp\r\n"
            )
            code = self._status_code(describe)

            # Camera issued an auth challenge — answer it and retry once.
            if code == 401 and username is not None:
                challenge = self._header(describe, "WWW-Authenticate")
                auth = self._build_auth(challenge, username, password or "", "DESCRIBE", url)
                if auth is None:
                    return ProbeResult(
                        False, "unauthorized", error="unsupported auth scheme from camera"
                    )
                describe = self._request(
                    sock,
                    "DESCRIBE",
                    url,
                    seq=3,
                    extra=f"Accept: application/sdp\r\nAuthorization: {auth}\r\n",
                )
                code = self._status_code(describe)

            latency = (time.perf_counter() - started) * 1000

            if code == 401:
                return ProbeResult(
                    False, "unauthorized", latency_ms=latency,
                    error="camera rejected the supplied credentials",
                )
            if code == 403:
                return ProbeResult(
                    False, "forbidden", latency_ms=latency,
                    error="camera refused access to this stream",
                )
            if code == 404:
                return ProbeResult(
                    False, "offline", latency_ms=latency,
                    error="stream path not found on this camera",
                )
            if code != 200:
                return ProbeResult(
                    False, "offline", latency_ms=latency, error=f"RTSP status {code}"
                )

            codec, resolution = self._parse_sdp(describe)
            return ProbeResult(
                True, "online", latency_ms=latency, codec=codec, resolution=resolution,
                detail={"rtsp_status": code},
            )

        except socket.timeout:
            return ProbeResult(False, "offline", error=f"timed out after {self.timeout}s")
        except OSError as exc:
            return ProbeResult(False, "offline", error=f"connection failed: {exc}")
        finally:
            if sock is not None:
                try:
                    sock.close()
                except OSError:
                    pass

    # -- protocol plumbing --------------------------------------------------
    def _request(self, sock, method: str, url: str, seq: int, extra: str = "") -> str:
        req = (
            f"{method} {url} RTSP/1.0\r\n"
            f"CSeq: {seq}\r\n"
            f"User-Agent: SmartCityAI/1.0\r\n"
            f"{extra}\r\n"
        )
        sock.sendall(req.encode())
        return self._read_response(sock)

    @staticmethod
    def _read_response(sock) -> str:
        """Read headers, then any Content-Length body (the SDP)."""
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = sock.recv(4096)
            if not chunk:
                break
            buf += chunk
            if len(buf) > 262_144:  # guard against a hostile/broken peer
                break

        text = buf.decode("utf-8", errors="replace")
        m = re.search(r"Content-Length:\s*(\d+)", text, re.IGNORECASE)
        if m:
            want = int(m.group(1))
            header_end = buf.find(b"\r\n\r\n") + 4
            have = len(buf) - header_end
            while have < want:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                buf += chunk
                have = len(buf) - header_end
            text = buf.decode("utf-8", errors="replace")
        return text

    @staticmethod
    def _status_code(response: str) -> int:
        m = re.match(r"RTSP/1\.0\s+(\d+)", response or "")
        return int(m.group(1)) if m else 0

    @staticmethod
    def _header(response: str, name: str) -> str:
        m = re.search(rf"^{name}:\s*(.+)$", response or "", re.IGNORECASE | re.MULTILINE)
        return m.group(1).strip() if m else ""

    @staticmethod
    def _build_auth(challenge: str, username: str, password: str, method: str, uri: str):
        if not challenge:
            return None
        if challenge.lower().startswith("digest"):
            return build_digest_header(challenge, username, password, method, uri)
        if challenge.lower().startswith("basic"):
            return _basic_header(username, password)
        return None

    @staticmethod
    def _parse_sdp(response: str) -> tuple[Optional[str], Optional[str]]:
        """Pull codec and frame size out of the SDP body."""
        codec = None
        resolution = None

        # a=rtpmap:96 H264/90000  →  H264
        m = re.search(r"a=rtpmap:\d+\s+([A-Za-z0-9\-]+)/", response or "")
        if m:
            codec = m.group(1).upper()

        # Cameras advertise dimensions in several dialects; try each.
        for pattern in (
            r"a=x-dimensions:\s*(\d+)\s*,\s*(\d+)",
            r"a=framesize:\d+\s+(\d+)-(\d+)",
            r"a=cliprect:\d+,\d+,(\d+),(\d+)",
        ):
            m = re.search(pattern, response or "")
            if m:
                resolution = f"{m.group(1)}x{m.group(2)}"
                break

        return codec, resolution


# --------------------------------------------------------------------------
# ONVIF (Profile S) over SOAP
# --------------------------------------------------------------------------
_SOAP_ENVELOPE = """<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:tds="http://www.onvif.org/ver10/device/wsdl"
            xmlns:trt="http://www.onvif.org/ver10/media/wsdl"
            xmlns:tt="http://www.onvif.org/ver10/schema">
  <s:Header>{security}</s:Header>
  <s:Body>{body}</s:Body>
</s:Envelope>"""

_WS_SECURITY = """<Security s:mustUnderstand="1"
    xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
  <UsernameToken>
    <Username>{username}</Username>
    <Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">{digest}</Password>
    <Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">{nonce}</Nonce>
    <Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">{created}</Created>
  </UsernameToken>
</Security>"""


class ONVIFClient:
    """
    Just enough ONVIF to onboard and monitor a traffic camera.

    ONVIF's job here is discovery-of-capability: given a host and credentials
    it tells us the make/model/firmware, what media profiles exist, and the
    exact RTSP URI and snapshot URI to use — so an operator only has to enter
    an IP address instead of hand-writing stream paths per camera vendor.
    """

    def __init__(self, host: str, port: int, username: str = "", password: str = "",
                 timeout: Optional[float] = None):
        self.host = host
        self.port = port or settings.camera_default_onvif_port
        self.username = username
        self.password = password
        self.timeout = timeout or settings.camera_connect_timeout_s

    @property
    def device_url(self) -> str:
        return f"http://{self.host}:{self.port}/onvif/device_service"

    @property
    def media_url(self) -> str:
        return f"http://{self.host}:{self.port}/onvif/media_service"

    def _security_header(self) -> str:
        """WS-Security UsernameToken with PasswordDigest (never plaintext)."""
        if not self.username:
            return ""
        nonce_bytes = secrets.token_bytes(16)
        created = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        digest = base64.b64encode(
            hashlib.sha1(nonce_bytes + created.encode() + self.password.encode()).digest()
        ).decode()
        return _WS_SECURITY.format(
            username=self.username,
            digest=digest,
            nonce=base64.b64encode(nonce_bytes).decode(),
            created=created,
        )

    def _call(self, url: str, body: str) -> tuple[int, str]:
        envelope = _SOAP_ENVELOPE.format(security=self._security_header(), body=body)
        try:
            with httpx.Client(timeout=self.timeout) as client:
                resp = client.post(
                    url,
                    content=envelope.encode(),
                    headers={"Content-Type": "application/soap+xml; charset=utf-8"},
                )
                return resp.status_code, resp.text
        except httpx.HTTPError as exc:
            return 0, str(exc)

    @staticmethod
    def _tag(xml: str, tag: str) -> Optional[str]:
        m = re.search(rf"<(?:\w+:)?{tag}[^>]*>(.*?)</(?:\w+:)?{tag}>", xml or "", re.DOTALL)
        return m.group(1).strip() if m else None

    def device_information(self) -> ProbeResult:
        started = time.perf_counter()
        code, xml = self._call(self.device_url, "<tds:GetDeviceInformation/>")
        latency = (time.perf_counter() - started) * 1000

        if code == 0:
            return ProbeResult(False, "offline", error=f"ONVIF transport error: {xml[:200]}")
        if code in (401, 403):
            return ProbeResult(False, "unauthorized", latency_ms=latency,
                               error="ONVIF credentials rejected")
        if code != 200:
            # SOAP faults come back as 400/500 with a Fault body.
            fault = self._tag(xml, "Text") or f"HTTP {code}"
            status = "unauthorized" if "auth" in fault.lower() else "offline"
            return ProbeResult(False, status, latency_ms=latency, error=fault[:200])

        return ProbeResult(
            True, "online", latency_ms=latency,
            detail={
                "manufacturer": self._tag(xml, "Manufacturer"),
                "model": self._tag(xml, "Model"),
                "firmware": self._tag(xml, "FirmwareVersion"),
                "serial": self._tag(xml, "SerialNumber"),
            },
        )

    def profiles(self) -> list[dict]:
        """Enumerate media profiles (main stream, sub stream, ...)."""
        code, xml = self._call(self.media_url, "<trt:GetProfiles/>")
        if code != 200:
            return []
        out = []
        for block in re.findall(r"<(?:\w+:)?Profiles\b(.*?)</(?:\w+:)?Profiles>", xml, re.DOTALL):
            token = re.search(r'token="([^"]+)"', block)
            width = self._tag(block, "Width")
            height = self._tag(block, "Height")
            out.append({
                "token": token.group(1) if token else None,
                "name": self._tag(block, "Name"),
                "encoding": self._tag(block, "Encoding"),
                "resolution": f"{width}x{height}" if width and height else None,
                "width": int(width) if width and width.isdigit() else None,
            })
        return out

    def stream_uri(self, profile_token: str) -> Optional[str]:
        body = (
            "<trt:GetStreamUri>"
            "<trt:StreamSetup>"
            "<tt:Stream>RTP-Unicast</tt:Stream>"
            "<tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport>"
            "</trt:StreamSetup>"
            f"<trt:ProfileToken>{profile_token}</trt:ProfileToken>"
            "</trt:GetStreamUri>"
        )
        code, xml = self._call(self.media_url, body)
        return self._tag(xml, "Uri") if code == 200 else None

    def snapshot_uri(self, profile_token: str) -> Optional[str]:
        body = f"<trt:GetSnapshotUri><trt:ProfileToken>{profile_token}</trt:ProfileToken></trt:GetSnapshotUri>"
        code, xml = self._call(self.media_url, body)
        return self._tag(xml, "Uri") if code == 200 else None


# --------------------------------------------------------------------------
# Facade used by the routers
# --------------------------------------------------------------------------
class CameraConnector:
    """What the API layer calls. Knows nothing about SQL, everything about cameras."""

    def __init__(self):
        self.rtsp = RTSPProbe()

    # -- URL construction ---------------------------------------------------
    def stream_url(self, camera, substream: bool = False) -> str:
        """Build the RTSP URL, embedding credentials only in the live URL."""
        port = camera.port or settings.camera_default_rtsp_port
        path = (camera.substream_path if substream else camera.stream_path) or ""
        if path and not path.startswith("/"):
            path = "/" + path
        return f"rtsp://{camera.host}:{port}{path}"

    def analytics_stream_url(self, camera) -> str:
        """
        Prefer the low-resolution sub-stream for computer vision.

        A vehicle is just as detectable at 640x480 as at 4MP, and decoding the
        main stream for every camera is what makes CV pipelines fall over at
        city scale.
        """
        return self.stream_url(camera, substream=bool(camera.substream_path))

    # -- Health -------------------------------------------------------------
    def test(self, camera) -> ProbeResult:
        """Contact the camera and report exactly what happened."""
        if not camera.authorized:
            return ProbeResult(
                False, "unauthorized",
                error=(
                    "camera is not marked authorised — record the data-sharing "
                    "agreement or permit before the platform will contact it"
                ),
            )

        password = resolve_secret(camera.credential_ref)
        username = camera.username or ""

        if camera.protocol == "onvif":
            client = ONVIFClient(camera.host, camera.port or settings.camera_default_onvif_port,
                                 username, password or "")
            result = client.device_information()
            if result.ok:
                # Enrich with the real stream parameters the camera reports.
                profs = client.profiles()
                if profs:
                    main = max(profs, key=lambda p: p.get("width") or 0)
                    result.codec = main.get("encoding")
                    result.resolution = main.get("resolution")
                    result.detail["profiles"] = profs
            return result

        if camera.protocol == "http_snapshot":
            return self._probe_snapshot(camera, username, password)

        # default: rtsp
        return self.rtsp.probe(self.stream_url(camera), username, password)

    def _probe_snapshot(self, camera, username: str, password: Optional[str]) -> ProbeResult:
        path = camera.snapshot_path or "/"
        if not path.startswith("/"):
            path = "/" + path
        url = f"http://{camera.host}:{camera.port or 80}{path}"
        started = time.perf_counter()
        try:
            with httpx.Client(timeout=settings.camera_snapshot_timeout_s) as client:
                resp = client.get(url)
                if resp.status_code == 401 and username:
                    challenge = resp.headers.get("WWW-Authenticate", "")
                    if challenge.lower().startswith("digest"):
                        hdr = build_digest_header(
                            challenge, username, password or "", "GET", path
                        )
                    else:
                        hdr = _basic_header(username, password or "")
                    resp = client.get(url, headers={"Authorization": hdr})

                latency = (time.perf_counter() - started) * 1000
                if resp.status_code in (401, 403):
                    return ProbeResult(False, "unauthorized", latency_ms=latency,
                                       error="snapshot endpoint rejected credentials")
                if resp.status_code != 200:
                    return ProbeResult(False, "offline", latency_ms=latency,
                                       error=f"HTTP {resp.status_code}")
                ctype = resp.headers.get("content-type", "")
                if "image" not in ctype:
                    return ProbeResult(False, "offline", latency_ms=latency,
                                       error=f"expected an image, got {ctype or 'unknown'}")
                return ProbeResult(True, "online", latency_ms=latency, codec="MJPEG",
                                   detail={"bytes": len(resp.content)})
        except httpx.HTTPError as exc:
            return ProbeResult(False, "offline", error=f"snapshot request failed: {exc}")

    def onboard(self, host: str, port: int, username: str, password: str) -> dict:
        """
        Point ONVIF at an IP and have it tell us how to use the camera.

        Returns the device identity plus a ready-to-store main/sub stream
        configuration, which is what the "Add camera" flow in the UI submits.
        """
        client = ONVIFClient(host, port, username, password)
        info = client.device_information()
        if not info.ok:
            return {"ok": False, "status": info.status, "error": info.error}

        profiles = client.profiles()
        main = max(profiles, key=lambda p: p.get("width") or 0, default=None)
        sub = min(profiles, key=lambda p: p.get("width") or 10**9, default=None)

        return {
            "ok": True,
            "device": info.detail,
            "profiles": profiles,
            "main_stream_uri": client.stream_uri(main["token"]) if main and main.get("token") else None,
            "sub_stream_uri": client.stream_uri(sub["token"]) if sub and sub.get("token") else None,
            "snapshot_uri": client.snapshot_uri(main["token"]) if main and main.get("token") else None,
            "latency_ms": info.latency_ms,
        }


camera_connector = CameraConnector()


def apply_probe_result(camera, result: ProbeResult) -> None:
    """Write a ProbeResult onto a Camera row. Shared by the router and the Celery sweep."""
    camera.status = result.status
    camera.latency_ms = result.latency_ms
    camera.last_error = result.error
    if result.ok:
        from datetime import datetime
        camera.last_seen = datetime.utcnow()
        camera.codec = result.codec or camera.codec
        camera.resolution = result.resolution or camera.resolution
        detail = result.detail or {}
        camera.manufacturer = detail.get("manufacturer") or camera.manufacturer
        camera.model = detail.get("model") or camera.model
        camera.firmware = detail.get("firmware") or camera.firmware


def sweep_fleet(db, limit: int = 200) -> dict:
    """
    Probe every enabled camera and update its stored health.

    Pulled out of the router so it has exactly one implementation: the
    `POST /api/cameras/health-sweep` endpoint (operator-triggered) and the
    scheduled Celery task (`app.workers.tasks.camera_health_sweep`) both call
    this rather than one calling the other over HTTP — Celery tasks in this
    codebase run service code directly against the database, the same
    pattern `scan_all_road_segments` uses for road damage.
    """
    from app.models.camera import Camera  # local import avoids a circular import at module load

    cameras = db.query(Camera).filter(Camera.enabled == True).limit(limit).all()  # noqa: E712

    checked = skipped = online = 0
    results = []
    for camera in cameras:
        if not camera.authorized:
            skipped += 1
            camera.status = "unauthorized"
            camera.last_error = "no authorisation on record"
            results.append({"camera_id": camera.id, "name": camera.name,
                            "status": "unauthorized", "skipped": True})
            continue

        previous_status = camera.status
        result = camera_connector.test(camera)
        apply_probe_result(camera, result)
        checked += 1
        online += 1 if result.ok else 0
        results.append({"camera_id": camera.id, "name": camera.name,
                        "status": result.status, "latency_ms": result.latency_ms,
                        "error": result.error})

        # Publish on change, not on every probe: the sweep runs every 10
        # minutes over the whole fleet, and a live feed only cares when a
        # camera's state actually moved (came online, went offline).
        if result.status != previous_status:
            from app.services.live import publish_event
            publish_event({
                "type": "camera_status", "camera_id": camera.id, "name": camera.name,
                "status": result.status, "emirate": camera.emirate,
            })

    db.commit()
    return {"checked": checked, "skipped_unauthorized": skipped,
            "online": online, "results": results}
