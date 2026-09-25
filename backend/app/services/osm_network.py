"""
M10 — real UAE road network ingestion.

Pulls the actual UAE highway network out of OpenStreetMap through the public
Overpass API and persists true LINESTRING geometry into PostGIS. After this
runs, every other module — routing, the digital twin map, corridor design —
is working against the real road layout of all seven emirates rather than a
hand-drawn demo graph.

Why Overpass and not a Geofabrik `.osm.pbf` extract: the PBF for the UAE is
~100MB and needs osm2pgsql plus a few hundred MB of RAM to import. Overpass
lets us request exactly the highway classes we route on and returns inline
geometry, which imports in seconds on a laptop. The trade-off is that it is a
shared public service, so we ask for a bounded region and cache the result.

Cross-border corridors are first-class here: `barrier=border_control` nodes
give us the real crossings into Oman and Saudi Arabia, and any link within
`INTERNATIONAL_RADIUS_KM` of one is flagged `is_international` so freight and
incident routing can reason about them.
"""
from __future__ import annotations

import math
import time
from datetime import datetime
from typing import Iterable, Optional

import httpx
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models.network import RoadLink, BorderCrossing

settings = get_settings()

# Road classes we route on by default: the strategic network.
#
# Adding `secondary` and the `_link` slip roads roughly quadruples the ingest
# and is what pushes public Overpass instances into timing out, for little
# benefit to inter-city routing or corridor planning. Pass `classes=` to the
# ingest endpoint when you need the finer network in a specific area.
DEFAULT_HIGHWAY_CLASSES = ["motorway", "trunk", "primary"]

# Everything the router will traverse if present in the database.
ROUTABLE_CLASSES = DEFAULT_HIGHWAY_CLASSES + [
    "secondary", "motorway_link", "trunk_link", "primary_link", "secondary_link",
]

# A link this close to a border post is part of the international corridor.
INTERNATIONAL_RADIUS_KM = 8.0

# Rough emirate extents (south, west, north, east) used to label links for
# filtering in the UI. Approximate by design — the authoritative boundary is
# the municipality polygon, which a production deployment loads from GIS.
EMIRATE_BOXES: dict[str, tuple[float, float, float, float]] = {
    "Abu Dhabi":       (22.5, 51.0, 25.10, 55.30),
    "Dubai":           (24.75, 54.85, 25.35, 55.60),
    "Sharjah":         (25.20, 55.35, 25.60, 56.40),
    "Ajman":           (25.35, 55.40, 25.50, 55.60),
    "Umm Al Quwain":   (25.45, 55.50, 25.75, 55.80),
    "Ras Al Khaimah":  (25.60, 55.70, 26.20, 56.40),
    "Fujairah":        (24.90, 56.10, 25.85, 56.45),
}


# --------------------------------------------------------------------------
# Geometry helpers
# --------------------------------------------------------------------------
def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in km."""
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def line_length_m(points: list[tuple[float, float]]) -> float:
    """Length of a polyline given as [(lat, lon), ...]."""
    total = 0.0
    for (a_lat, a_lon), (b_lat, b_lon) in zip(points, points[1:]):
        total += haversine_km(a_lat, a_lon, b_lat, b_lon)
    return total * 1000.0


def to_wkt_linestring(points: list[tuple[float, float]]) -> str:
    """WKT is lon-lat ordered; OSM geometry is lat-lon."""
    coords = ", ".join(f"{lon} {lat}" for lat, lon in points)
    return f"SRID=4326;LINESTRING({coords})"


def _box_area(box: tuple[float, float, float, float]) -> float:
    s, w, n, e = box
    return (n - s) * (e - w)


# Parts of emirates that fall outside their main rectangle. Without these,
# inland Abu Dhabi around Al Ain matched no box at all and was left
# unlabelled, and Sharjah's east-coast exclaves were labelled Fujairah because
# they sit inside Fujairah's rectangle. Buraimi (Oman) lies inside the Al Ain
# box and will be labelled Abu Dhabi — the limit of rectangles; municipality
# polygons are the real fix.
EMIRATE_EXTRA_BOXES: list[tuple[str, tuple[float, float, float, float]]] = [
    ("Abu Dhabi", (23.60, 55.30, 24.75, 56.05)),   # Al Ain region
    ("Dubai",     (24.72, 56.00, 24.88, 56.25)),   # Hatta exclave
    ("Sharjah",   (25.28, 56.30, 25.40, 56.38)),   # Khor Fakkan
    ("Sharjah",   (25.00, 56.30, 25.10, 56.40)),   # Kalba
    ("Sharjah",   (24.92, 55.70, 25.05, 55.85)),   # Al Madam
]

# Smallest box first. Abu Dhabi's extent is ~25x Dubai's and overlaps it, so
# checking in declaration order would label most of Dubai as Abu Dhabi. The
# tightest box that contains a point is the better guess — which is also what
# lets a small exclave box win over the large rectangle it sits inside.
_EMIRATES_BY_SPECIFICITY = sorted(
    list(EMIRATE_BOXES.items()) + EMIRATE_EXTRA_BOXES,
    key=lambda kv: _box_area(kv[1]),
)


def classify_emirate(lat: float, lon: float) -> Optional[str]:
    """Best-effort emirate label from a coordinate."""
    for name, (s, w, n, e) in _EMIRATES_BY_SPECIFICITY:
        if s <= lat <= n and w <= lon <= e:
            return name
    return None


def _parse_int(value) -> Optional[int]:
    """OSM tags are free text: '120', '120 km/h', '2;3' all appear."""
    if value is None:
        return None
    digits = ""
    for ch in str(value):
        if ch.isdigit():
            digits += ch
        elif digits:
            break
    return int(digits) if digits else None


# --------------------------------------------------------------------------
# Overpass client
# --------------------------------------------------------------------------
# Public Overpass instances, in preference order. The main overpass-api.de is
# frequently saturated (504) and rate-limits repeat callers (429), so it goes
# last and we fail over to the community mirrors first.
#
# Only *global* instances belong here. Regional deployments such as
# overpass.osm.ch answer HTTP 200 with zero elements for anything outside
# their extract, which is indistinguishable from "no roads here" — a silent
# wrong answer is worse than a failure.
OVERPASS_MIRRORS = [
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass-api.de/api/interpreter",
]


class OverpassError(RuntimeError):
    pass


class OverpassClient:
    def __init__(self, url: Optional[str] = None, timeout: Optional[int] = None):
        configured = url or settings.overpass_url
        # Honour an explicitly configured endpoint first, then the mirrors.
        # `settings.overpass_url` defaults to overpass-api.de, which we do not
        # want to promote, so only a non-default value jumps the queue.
        if configured and configured not in OVERPASS_MIRRORS:
            self.endpoints = [configured] + OVERPASS_MIRRORS
        else:
            self.endpoints = list(OVERPASS_MIRRORS)
        self.timeout = timeout or settings.overpass_timeout_s
        # Once a mirror answers, keep using it: re-probing a dead endpoint for
        # every tile is what turns a 30s ingest into a 10-minute one.
        self._preferred: Optional[str] = None
        # Circuit breaker: endpoint -> monotonic time it may be tried again.
        self._benched_until: dict[str, float] = {}

    # A failing mirror is benched for this long. Long enough that a tile loop
    # stops paying a 30-40s timeout per request to a dead host; short enough
    # that a mirror recovering from a load spike is back in rotation quickly.
    BENCH_SECONDS = 240.0

    def _bench(self, endpoint: str) -> None:
        self._benched_until[endpoint] = time.monotonic() + self.BENCH_SECONDS
        if self._preferred == endpoint:
            self._preferred = None

    def _available(self) -> list[str]:
        """Endpoints in try-order: preferred first, benched ones last."""
        now = time.monotonic()
        live = [e for e in self.endpoints if self._benched_until.get(e, 0) <= now]
        benched = [e for e in self.endpoints if e not in live]
        if self._preferred in live:
            live = [self._preferred] + [e for e in live if e != self._preferred]
        # Benched mirrors are still tried as a last resort — if every mirror is
        # benched, giving up without asking would turn a blip into a failure.
        return live + benched

    def query(self, ql: str, attempts_per_mirror: int = 2) -> dict:
        """
        Run an Overpass QL query, failing over across mirrors.

        504/429 mean "this instance is busy", not "the query is wrong", so we
        move to the next mirror rather than aborting the ingest — and bench the
        busy one, so the next tile does not wait out the same timeout again.
        The client is shared across worker threads, so one thread discovering
        a dead mirror spares all the others.
        """
        last_error: Optional[str] = None

        for endpoint in self._available():
            for attempt in range(attempts_per_mirror):
                try:
                    with httpx.Client(timeout=self.timeout) as client:
                        resp = client.post(
                            endpoint,
                            data={"data": ql},
                            headers={"User-Agent": "SmartCityAI/1.0 (urban planning POC)"},
                        )
                    if resp.status_code in (429, 502, 503, 504):
                        last_error = f"{endpoint} -> HTTP {resp.status_code}"
                        self._bench(endpoint)
                        break  # busy instance — move on rather than retrying it
                    resp.raise_for_status()
                    self._benched_until.pop(endpoint, None)
                    self._preferred = endpoint
                    return resp.json()
                except httpx.ConnectError as exc:
                    # Host unreachable: no point retrying it on this tile.
                    last_error = f"{endpoint} -> ConnectError: {exc}"
                    self._bench(endpoint)
                    break
                except (httpx.HTTPError, ValueError) as exc:
                    last_error = f"{endpoint} -> {type(exc).__name__}: {exc}"
                    if attempt == attempts_per_mirror - 1:
                        self._bench(endpoint)
                    else:
                        time.sleep(1 + attempt * 2)

        raise OverpassError(f"all Overpass mirrors failed; last error: {last_error}")

    @staticmethod
    def _highway_ql(bbox_str: str, classes: Iterable[str], ql_timeout: int) -> str:
        """
        Build a highway query using one exact-match statement per class.

        Not a style choice: `["highway"~"^(motorway|trunk)$"]` makes Overpass
        evaluate a regex against the tag index and reliably times out (504) on
        a country-sized box, while the union of `["highway"="motorway"]`
        statements below is an indexed lookup and returns the same rows. This
        single change is the difference between the ingest failing and working.
        """
        statements = "".join(
            f'way["highway"="{cls}"]({bbox_str});' for cls in classes
        )
        return f"[out:json][timeout:{ql_timeout}];({statements});out geom;"

    def highways_by_tile(self, bbox: tuple[float, float, float, float],
                         classes: Iterable[str], tiles: int = 4,
                         ql_timeout: int = 90):
        """
        Yield `(label, elements, error)` per tile of a `tiles`x`tiles` grid.

        One country-wide query is exactly the shape of request public Overpass
        instances reject, so we tile it. Yielding per tile (rather than
        returning one big list) lets the caller persist as it goes: progress is
        visible in the API, memory stays bounded, and a failed tile costs one
        tile instead of the whole network.
        """
        classes = list(classes)
        s, w, n, e = bbox
        lat_step = (n - s) / tiles
        lon_step = (e - w) / tiles

        for i in range(tiles):
            for j in range(tiles):
                t_s = s + i * lat_step
                t_n = t_s + lat_step
                t_w = w + j * lon_step
                t_e = t_w + lon_step
                label = f"({t_s:.2f},{t_w:.2f})-({t_n:.2f},{t_e:.2f})"
                ql = self._highway_ql(
                    f"{t_s},{t_w},{t_n},{t_e}", classes, ql_timeout
                )
                try:
                    yield label, self.query(ql).get("elements", []), None
                except OverpassError as exc:
                    yield label, [], str(exc)

    def highways(self, bbox: tuple[float, float, float, float],
                 classes: Iterable[str], tiles: int = 3) -> list[dict]:
        """Buffered variant, kept for callers that want the whole set at once."""
        elements: list[dict] = []
        seen: set[int] = set()
        failures: list[str] = []
        for label, batch, error in self.highways_by_tile(bbox, classes, tiles):
            if error:
                failures.append(f"tile{label}: {error}")
                continue
            for el in batch:
                if el.get("id") not in seen:
                    seen.add(el.get("id"))
                    elements.append(el)
        if not elements and failures:
            raise OverpassError("; ".join(failures[:3]))
        return elements

    def border_controls(self, bbox: tuple[float, float, float, float]) -> list[dict]:
        s, w, n, e = bbox
        ql = f"""
[out:json][timeout:60];
(
  node["barrier"="border_control"]({s},{w},{n},{e});
  way["barrier"="border_control"]({s},{w},{n},{e});
);
out center;
"""
        return self.query(ql).get("elements", [])


overpass = OverpassClient()


# --------------------------------------------------------------------------
# Ingestion
# --------------------------------------------------------------------------
def ingest_road_network(
    db: Session,
    bbox: Optional[tuple[float, float, float, float]] = None,
    classes: Optional[list[str]] = None,
    replace: bool = True,
    tiles: int = 4,
) -> dict:
    """
    Fetch the UAE highway network from OSM and load it into PostGIS.

    Idempotent by default: `replace=True` clears the table first so a re-run
    refreshes the network instead of duplicating it.
    """
    bbox = bbox or settings.uae_bbox
    classes = classes or DEFAULT_HIGHWAY_CLASSES

    # Clear first so progress is visible in /status while tiles stream in,
    # rather than the table sitting empty until the very end.
    if replace:
        db.query(RoadLink).delete()
        db.commit()
        seen_ids: set[int] = set()
    else:
        # Top-up mode: seed the dedupe set from what is already stored so a
        # follow-up run over a region that partly failed can't duplicate ways.
        seen_ids = {
            row[0] for row in db.query(RoadLink.osm_id).filter(RoadLink.osm_id.isnot(None)).all()
        }

    inserted = 0
    skipped = 0
    returned = 0
    total_km = 0.0
    failures: list[str] = []

    for label, elements, error in overpass.highways_by_tile(bbox, classes, tiles=tiles):
        if error:
            failures.append(f"tile{label}: {error}")
            continue

        returned += len(elements)
        for el in elements:
            osm_id = el.get("id")
            # Ways straddling a tile edge are returned by both tiles.
            if osm_id in seen_ids:
                continue
            seen_ids.add(osm_id)

            geometry = el.get("geometry") or []
            if len(geometry) < 2:
                skipped += 1
                continue

            points = [(p["lat"], p["lon"]) for p in geometry]
            tags = el.get("tags") or {}
            length = line_length_m(points)
            mid = points[len(points) // 2]
            nodes = el.get("nodes") or []

            # Prefer the English road name: OSM's plain `name` is usually the
            # Arabic form in the UAE, which reads wrong in turn-by-turn steps
            # and in an English search box. Arabic is preserved separately.
            road_name = tags.get("name:en") or tags.get("name")

            db.add(RoadLink(
                osm_id=osm_id,
                name=road_name,
                name_ar=tags.get("name:ar") or (
                    tags.get("name") if tags.get("name") != road_name else None
                ),
                ref=tags.get("ref"),
                highway=tags.get("highway", "unknown"),
                geom=to_wkt_linestring(points),
                length_m=length,
                lanes=_parse_int(tags.get("lanes")),
                maxspeed_kmh=_parse_int(tags.get("maxspeed")),
                oneway=str(tags.get("oneway", "")).lower() in ("yes", "1", "true", "-1"),
                bridge=bool(tags.get("bridge")),
                tunnel=bool(tags.get("tunnel")),
                toll=str(tags.get("toll", "")).lower() in ("yes", "1", "true"),
                start_node=nodes[0] if nodes else None,
                end_node=nodes[-1] if nodes else None,
                emirate=classify_emirate(*mid),
            ))
            inserted += 1
            total_km += length / 1000.0

            if inserted % 500 == 0:
                db.commit()

        db.commit()  # land each tile before fetching the next

    if inserted == 0 and failures:
        raise OverpassError("; ".join(failures[:3]))

    return {
        "elements_returned": returned,
        "links_inserted": inserted,
        "skipped": skipped,
        "network_km": round(total_km, 1),
        "tiles_failed": len(failures),
        "bbox": bbox,
        "highway_classes": classes,
    }


def gapfill_tiles(db: Session, bbox: tuple[float, float, float, float],
                  classes: list[str], tiles: int,
                  min_midpoints: int = 25) -> dict:
    """
    Re-fetch only the tiles of a grid that appear not to have landed.

    A tiled import that loses some tiles to Overpass timeouts leaves holes, and
    re-running the whole grid to fill them repeats every request that already
    succeeded — for Dubai's 36-tile core, 29 heavy requests to recover 7.

    Instead, count stored links of these classes whose *midpoint* falls inside
    each tile, and re-query only tiles below `min_midpoints`. Midpoints rather
    than plain intersection, because ways fetched for a neighbouring tile
    legitimately cross the shared edge and would make a failed tile look
    populated. Sea and desert tiles also come up empty and get re-asked, but
    they return almost nothing, so they cost little.
    """
    from sqlalchemy import func

    s, w, n, e = bbox
    lat_step = (n - s) / tiles
    lon_step = (e - w) / tiles
    midpoint = func.ST_LineInterpolatePoint(RoadLink.geom, 0.5)

    checked = refetched = inserted = failed = 0
    holes: list[str] = []

    for i in range(tiles):
        for j in range(tiles):
            ts, tw = s + i * lat_step, w + j * lon_step
            tn, te = ts + lat_step, tw + lon_step
            envelope = func.ST_MakeEnvelope(tw, ts, te, tn, 4326)

            present = (
                db.query(func.count(RoadLink.id))
                .filter(RoadLink.highway.in_(classes))
                # Index-backed bbox test first, so the midpoint is only
                # computed for links already near this tile.
                .filter(func.ST_Intersects(RoadLink.geom, envelope))
                .filter(func.ST_Intersects(midpoint, envelope))
                .scalar() or 0
            )
            checked += 1
            if present >= min_midpoints:
                continue

            refetched += 1
            label = f"({ts:.3f},{tw:.3f})"
            try:
                # Reuse the normal path: same parsing, same English-name rule,
                # same osm_id dedupe — a one-tile ingest of just this cell.
                r = ingest_road_network(db, bbox=(ts, tw, tn, te), classes=classes,
                                        replace=False, tiles=1)
                inserted += r["links_inserted"]
                if r["links_inserted"]:
                    holes.append(f"{label}+{r['links_inserted']}")
            except OverpassError:
                failed += 1

    return {
        "tiles_checked": checked,
        "tiles_refetched": refetched,
        "links_inserted": inserted,
        "still_failed": failed,
        "filled": holes,
    }


def ingest_border_crossings(db: Session,
                            bbox: Optional[tuple[float, float, float, float]] = None,
                            replace: bool = True) -> dict:
    """
    Load the real border posts on the UAE frontier from OSM, then fill in the
    major named crossings that OSM may not tag, so the corridor list is never
    empty in a demo.
    """
    bbox = bbox or settings.uae_bbox
    elements = overpass.border_controls(bbox)

    if replace:
        db.query(BorderCrossing).delete()
        db.commit()

    seen: set[tuple[float, float]] = set()
    inserted = 0

    for el in elements:
        if el.get("type") == "node":
            lat, lon = el.get("lat"), el.get("lon")
        else:
            centre = el.get("center") or {}
            lat, lon = centre.get("lat"), centre.get("lon")
        if lat is None or lon is None:
            continue

        key = (round(lat, 3), round(lon, 3))
        if key in seen:
            continue
        seen.add(key)

        tags = el.get("tags") or {}
        db.add(BorderCrossing(
            name=tags.get("name") or tags.get("name:en") or "Unnamed border post",
            geom=f"SRID=4326;POINT({lon} {lat})",
            country_b=_infer_neighbour(lat, lon),
            emirate=classify_emirate(lat, lon),
            road_ref=tags.get("ref"),
            open_24h=str(tags.get("opening_hours", "")).lower() in ("24/7", ""),
            source="OpenStreetMap",
        ))
        inserted += 1

    # Named crossings that matter operationally, added if OSM didn't supply
    # one nearby. Coordinates are approximate to ~1km and flagged as such.
    for c in KNOWN_CROSSINGS:
        if any(haversine_km(c["lat"], c["lon"], k[0], k[1]) < 5 for k in seen):
            continue
        db.add(BorderCrossing(
            name=c["name"],
            geom=f"SRID=4326;POINT({c['lon']} {c['lat']})",
            country_b=c["country_b"],
            emirate=c.get("emirate"),
            road_ref=c.get("road_ref"),
            freight_enabled=c.get("freight", True),
            notes=c.get("notes"),
            source="curated (approximate position)",
        ))
        inserted += 1

    db.commit()
    return {"crossings_inserted": inserted, "from_osm": len(seen)}


def _infer_neighbour(lat: float, lon: float) -> str:
    """West of ~52.5E on the Gulf coast is the Saudi frontier; east is Oman."""
    return "Saudi Arabia" if lon < 52.5 else "Oman"


# Major UAE land frontier posts. Positions are approximate (~1km) and exist so
# the corridor view is populated even when OSM tagging is sparse; the OSM
# import above takes precedence wherever it supplies a post.
KNOWN_CROSSINGS = [
    {"name": "Al Ghuwaifat", "lat": 24.115, "lon": 51.600, "country_b": "Saudi Arabia",
     "emirate": "Abu Dhabi", "road_ref": "E11", "freight": True,
     "notes": "Main UAE-Saudi freight gateway on the E11 transit route toward Qatar."},
    {"name": "Hatta / Al Wajajah", "lat": 24.790, "lon": 56.140, "country_b": "Oman",
     "emirate": "Dubai", "road_ref": "E44", "freight": True,
     "notes": "Primary Dubai-Muscat road crossing."},
    {"name": "Khatmat Malaha", "lat": 24.967, "lon": 56.358, "country_b": "Oman",
     "emirate": "Sharjah", "road_ref": "E99", "freight": True,
     "notes": "24-hour crossing on the east coast near Kalba."},
    {"name": "Al Darah / Al Jeer", "lat": 26.055, "lon": 56.140, "country_b": "Oman",
     "emirate": "Ras Al Khaimah", "road_ref": "E11", "freight": False,
     "notes": "Northern terminus of the E11; gateway to the Musandam exclave."},
    {"name": "Mezyad", "lat": 24.020, "lon": 55.835, "country_b": "Oman",
     "emirate": "Abu Dhabi", "road_ref": "E22", "freight": True,
     "notes": "Al Ain crossing toward Buraimi and the Omani interior."},
    {"name": "Hili", "lat": 24.250, "lon": 55.783, "country_b": "Oman",
     "emirate": "Abu Dhabi", "road_ref": "E20", "freight": False,
     "notes": "Al Ain-Buraimi crossing."},
]


def flag_international_links(db: Session) -> dict:
    """
    Mark every road link running up to a border post as part of an
    international corridor. Uses a real spatial query rather than a name match,
    so an unnamed approach road is still caught.
    """
    crossings = db.query(BorderCrossing).all()
    if not crossings:
        return {"flagged": 0, "reason": "no border crossings loaded"}

    from geoalchemy2.shape import to_shape

    db.query(RoadLink).update({RoadLink.is_international: False})
    db.commit()

    points = []
    for c in crossings:
        pt = to_shape(c.geom)
        points.append((pt.y, pt.x))

    flagged = 0
    # Only long-distance classes can form a corridor; a residential stub can't.
    candidates = db.query(RoadLink).filter(
        RoadLink.highway.in_(["motorway", "trunk", "primary", "secondary"])
    ).all()

    for link in candidates:
        line = to_shape(link.geom)
        lon, lat = line.coords[len(line.coords) // 2]
        if any(haversine_km(lat, lon, p[0], p[1]) <= INTERNATIONAL_RADIUS_KM for p in points):
            link.is_international = True
            flagged += 1

    db.commit()
    return {"flagged": flagged, "radius_km": INTERNATIONAL_RADIUS_KM}


def ingest_all(db: Session, bbox=None, classes=None) -> dict:
    """
    One call to build the whole network layer.

    Border crossings are ingested independently of the road network: if
    Overpass serves one query and not the other, we keep what we got rather
    than discarding a partial success. The curated crossing list means the
    corridor view is populated even if that query fails entirely.
    """
    started = datetime.utcnow()

    roads = ingest_road_network(db, bbox=bbox, classes=classes)

    try:
        borders = ingest_border_crossings(db, bbox=bbox)
    except OverpassError as exc:
        db.rollback()
        borders = _seed_curated_crossings_only(db, reason=str(exc))

    intl = flag_international_links(db)
    return {
        "roads": roads,
        "borders": borders,
        "international": intl,
        "seconds": round((datetime.utcnow() - started).total_seconds(), 1),
    }


def _seed_curated_crossings_only(db: Session, reason: str) -> dict:
    """Fallback when Overpass can't serve the border-control query."""
    db.query(BorderCrossing).delete()
    db.commit()
    for c in KNOWN_CROSSINGS:
        db.add(BorderCrossing(
            name=c["name"],
            geom=f"SRID=4326;POINT({c['lon']} {c['lat']})",
            country_b=c["country_b"],
            emirate=c.get("emirate"),
            road_ref=c.get("road_ref"),
            freight_enabled=c.get("freight", True),
            notes=c.get("notes"),
            source="curated (approximate position)",
        ))
    db.commit()
    return {
        "crossings_inserted": len(KNOWN_CROSSINGS),
        "from_osm": 0,
        "fallback": True,
        "reason": reason[:200],
    }
