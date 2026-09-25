"""
Gazetteer ingestion — named places, buildings and amenities from OpenStreetMap.

Scope decision that shapes everything here: we import *named* features only.
OSM holds millions of building footprints for the UAE and almost all of them
are unnamed outlines. Importing the lot would take hours through Overpass,
consume gigabytes, and answer nothing a planner or dispatcher asks. A named
gazetteer — "Rashid Hospital", "Dubai Mall", "Al Barsha" — is what makes the
map searchable and what a geocoder actually needs.

Ways and relations are reduced to their centroid. A hospital's exact footprint
is irrelevant for search and routing-to-destination; its position is not.
"""
from __future__ import annotations

from datetime import datetime
from typing import Iterable, Optional

from sqlalchemy.orm import Session

from app.config import get_settings
from app.models.place import Place
from app.services.osm_network import (
    OverpassClient, OverpassError, classify_emirate, overpass,
)

settings = get_settings()

# Per-emirate boxes for staged ingestion. Overpass rejects country-sized
# queries for dense feature classes, and running emirate by emirate also means
# a failure costs one emirate rather than the whole import.
EMIRATE_BBOX: dict[str, tuple[float, float, float, float]] = {
    "Abu Dhabi":      (22.60, 51.50, 25.15, 55.35),
    "Dubai":          (24.75, 54.85, 25.40, 55.65),
    "Sharjah":        (25.05, 55.35, 25.65, 56.40),
    "Ajman":          (25.35, 55.40, 25.52, 55.75),
    "Umm Al Quwain":  (25.45, 55.50, 25.80, 55.90),
    "Ras Al Khaimah": (25.60, 55.70, 26.20, 56.40),
    "Fujairah":       (24.95, 56.05, 25.90, 56.45),
}

# Settlement tiers, ranked so search puts a city above a neighbourhood.
PLACE_RANK = {
    "city": 100, "town": 80, "suburb": 65, "village": 55,
    "neighbourhood": 45, "quarter": 45, "hamlet": 35, "locality": 25,
    "island": 50, "isolated_dwelling": 10,
}

# Amenities worth having in a city-operations gazetteer.
AMENITIES = [
    "hospital", "clinic", "doctors", "police", "fire_station", "school",
    "university", "college", "townhall", "courthouse", "embassy",
    "bus_station", "ferry_terminal", "fuel", "place_of_worship", "marketplace",
]

BUILDING_RANK = {
    "hospital": 70, "hotel": 55, "commercial": 45, "office": 45,
    "retail": 45, "mall": 60, "school": 55, "university": 60,
    "government": 65, "public": 50, "train_station": 60, "stadium": 60,
    "mosque": 50, "church": 45, "temple": 45,
}


def _centroid(el: dict) -> Optional[tuple[float, float]]:
    """Position of any element type: node coords, or way/relation centre."""
    if el.get("type") == "node":
        lat, lon = el.get("lat"), el.get("lon")
    else:
        centre = el.get("center") or {}
        lat, lon = centre.get("lat"), centre.get("lon")
    if lat is None or lon is None:
        return None
    return lat, lon


def _importance(category: str, subcategory: Optional[str], population: Optional[int]) -> float:
    """
    Search ranking weight.

    Population dominates for settlements — someone typing "Dubai" means the
    emirate, not a shop called Dubai — with a category floor so that a large
    hospital still outranks an unnamed locality.
    """
    base = 0.0
    if category == "place":
        base = PLACE_RANK.get(subcategory or "", 20)
        if population:
            # log-ish scaling: a million-person city shouldn't be 1000x a town
            base += min(60.0, (population ** 0.34) / 2.2)
    elif category == "amenity":
        base = {"hospital": 65, "university": 55, "police": 50,
                "fire_station": 50, "bus_station": 45}.get(subcategory or "", 32)
    elif category == "building":
        base = BUILDING_RANK.get(subcategory or "", 30)
    elif category in ("shop", "tourism", "landmark"):
        base = 35
    return round(base, 2)


def _parse_population(value) -> Optional[int]:
    try:
        return int(str(value).replace(",", "").split(".")[0])
    except (TypeError, ValueError):
        return None


def _flush(db: Session, rows: list[dict]) -> None:
    """
    Insert a batch, skipping anything already present.

    `ON CONFLICT DO NOTHING` against the unique (osm_type, osm_id) index is
    what makes the import safely re-runnable and safe to run concurrently for
    several emirates: overlapping features are dropped by the database instead
    of raising an IntegrityError that would abort the whole transaction.
    """
    if not rows:
        return
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    stmt = pg_insert(Place.__table__).values(rows)
    # The unique index is partial (WHERE osm_id IS NOT NULL), and Postgres only
    # matches an ON CONFLICT target to a partial index when the same predicate
    # is restated here — without index_where it raises "no unique or exclusion
    # constraint matching the ON CONFLICT specification".
    stmt = stmt.on_conflict_do_nothing(
        index_elements=[Place.osm_type, Place.osm_id],
        index_where=Place.osm_id.isnot(None),
    )
    db.execute(stmt)
    db.commit()
    rows.clear()


class PlaceIngester:
    def __init__(self, client: Optional[OverpassClient] = None):
        self.client = client or overpass

    # -- query builders -----------------------------------------------------
    def _ql(self, bbox: tuple[float, float, float, float], selectors: Iterable[str],
            timeout: int = 60) -> str:
        s, w, n, e = bbox
        b = f"{s},{w},{n},{e}"
        # `out center` gives ways/relations a centroid without their geometry,
        # which is the whole point — we want positions, not footprints.
        body = "".join(f"{sel}({b});" for sel in selectors)
        return f"[out:json][timeout:{timeout}];({body});out center;"

    @staticmethod
    def _auto_tiles(bbox: tuple[float, float, float, float],
                    tile_deg: float, cap: int = 8) -> int:
        """
        Choose a grid size from the bbox extent instead of a fixed number.

        A fixed grid is wrong at both ends: 6x6 over Ajman (0.17 x 0.35 deg)
        fires 36 requests at an area one query answers instantly, while the
        same 6x6 over Abu Dhabi (2.5 x 3.8 deg) leaves tiles big enough to time
        out. Sizing each tile to roughly `tile_deg` makes the request count
        track the work rather than the emirate count.
        """
        s, w, n, e = bbox
        span = max(n - s, e - w)
        return max(1, min(cap, int(span / tile_deg + 0.999)))

    def _tiled(self, bbox: tuple[float, float, float, float],
               selectors: list[str], tiles: int) -> list[dict]:
        """
        Run a selector set over a `tiles`x`tiles` grid and merge the results.

        An emirate-sized bbox for a dense feature class is exactly the request
        public Overpass instances answer with 504 — Abu Dhabi alone spans
        ~2.5 x 3.8 degrees. Tiling keeps each request small enough to be
        served, and one failed tile costs one tile.
        """
        s, w, n, e = bbox
        lat_step = (n - s) / tiles
        lon_step = (e - w) / tiles

        elements: list[dict] = []
        seen: set[tuple] = set()

        for i in range(tiles):
            for j in range(tiles):
                t_bbox = (s + i * lat_step, w + j * lon_step,
                          s + (i + 1) * lat_step, w + (j + 1) * lon_step)
                try:
                    batch = self.client.query(self._ql(t_bbox, selectors)).get("elements", [])
                except OverpassError:
                    continue  # skip this tile, keep the rest
                for el in batch:
                    key = (el.get("type"), el.get("id"))
                    if key in seen:
                        continue
                    seen.add(key)
                    elements.append(el)
        return elements

    def settlements(self, bbox, tiles: Optional[int] = None) -> list[dict]:
        sels = []
        for tier in PLACE_RANK:
            sels += [f'node["place"="{tier}"]', f'way["place"="{tier}"]']
        # Sparse class — large tiles are fine.
        return self._tiled(bbox, sels, tiles or self._auto_tiles(bbox, 1.5))

    def amenities(self, bbox, tiles: Optional[int] = None) -> list[dict]:
        # Batched selectors: all 32 at once pushed the request over the
        # instance's cost limit. Eight per query is comfortably under it and
        # halves the number of round trips versus four.
        elements: list[dict] = []
        seen: set[tuple] = set()
        grid = tiles or self._auto_tiles(bbox, 1.0)
        for start in range(0, len(AMENITIES), 8):
            sels = []
            for a in AMENITIES[start:start + 8]:
                # Named only — an unnamed fuel station is not a search result.
                sels += [f'node["amenity"="{a}"]["name"]', f'way["amenity"="{a}"]["name"]']
            for el in self._tiled(bbox, sels, grid):
                key = (el.get("type"), el.get("id"))
                if key not in seen:
                    seen.add(key)
                    elements.append(el)
        return elements

    def named_buildings(self, bbox, tiles: Optional[int] = None) -> list[dict]:
        # The densest class by far — smallest tiles.
        sels = ['way["building"]["name"]', 'relation["building"]["name"]']
        return self._tiled(bbox, sels, tiles or self._auto_tiles(bbox, 0.45))

    def landmarks(self, bbox, tiles: Optional[int] = None) -> list[dict]:
        sels = [
            'node["tourism"~"^(attraction|museum|hotel|viewpoint)$"]["name"]',
            'way["tourism"~"^(attraction|museum|hotel|viewpoint)$"]["name"]',
            'way["shop"="mall"]["name"]',
            'node["shop"="mall"]["name"]',
        ]
        return self._tiled(bbox, sels, tiles or self._auto_tiles(bbox, 1.2))


ingester = PlaceIngester()


def _classify(tags: dict) -> tuple[Optional[str], Optional[str]]:
    if tags.get("place"):
        return "place", tags["place"]
    if tags.get("amenity"):
        return "amenity", tags["amenity"]
    if tags.get("shop") == "mall":
        return "landmark", "mall"
    if tags.get("tourism"):
        return "landmark", tags["tourism"]
    if tags.get("building"):
        b = tags["building"]
        return "building", (b if b != "yes" else (tags.get("building:use") or "building"))
    return None, None


def ingest_places(db: Session, emirate: Optional[str] = None,
                  include_buildings: bool = True,
                  replace_scope: bool = True) -> dict:
    """
    Build the gazetteer for one emirate, or all of them.

    `replace_scope` clears only the rows for the emirates being (re-)imported,
    so re-running Dubai does not wipe Abu Dhabi.
    """
    targets = [emirate] if emirate else list(EMIRATE_BBOX)
    summary: dict[str, dict] = {}

    for name in targets:
        bbox = EMIRATE_BBOX.get(name)
        if not bbox:
            summary[name] = {"error": "unknown emirate"}
            continue

        if replace_scope:
            db.query(Place).filter(Place.emirate == name).delete()
            db.commit()

        counts = {"settlements": 0, "amenities": 0, "buildings": 0, "landmarks": 0}
        errors: list[str] = []
        seen: set[tuple] = set()
        pending: list[dict] = []

        jobs = [
            ("settlements", ingester.settlements),
            ("amenities", ingester.amenities),
            ("landmarks", ingester.landmarks),
        ]
        if include_buildings:
            jobs.append(("buildings", ingester.named_buildings))

        for label, fn in jobs:
            try:
                elements = fn(bbox)
            except OverpassError as exc:
                errors.append(f"{label}: {exc}")
                continue

            for el in elements:
                tags = el.get("tags") or {}
                # Prefer the English name. In the UAE OSM's plain `name` is
                # very often Arabic, so taking it first leaves an English
                # console showing "وسط مدينة دبي" where the user expects
                # "Downtown Dubai". The Arabic name is kept alongside and is
                # still searchable.
                place_name = tags.get("name:en") or tags.get("name")
                if not place_name:
                    continue
                pos = _centroid(el)
                if not pos:
                    continue
                lat, lon = pos

                category, subcategory = _classify(tags)
                if not category:
                    continue

                # Same feature can appear in more than one query (a named
                # hospital is both amenity and building).
                key = (place_name.lower(), round(lat, 4), round(lon, 4))
                if key in seen:
                    continue
                seen.add(key)

                population = _parse_population(tags.get("population"))
                pending.append({
                    "osm_id": el.get("id"),
                    "osm_type": el.get("type"),
                    "name": place_name,
                    # If `name` held the Arabic form, keep it rather than losing it.
                    "name_ar": tags.get("name:ar") or (
                        tags.get("name") if tags.get("name") != place_name else None
                    ),
                    "category": category,
                    "subcategory": subcategory,
                    "geom": f"SRID=4326;POINT({lon} {lat})",
                    "emirate": classify_emirate(lat, lon) or name,
                    "street": tags.get("addr:street"),
                    "postcode": tags.get("addr:postcode"),
                    "population": population,
                    "importance": _importance(category, subcategory, population),
                })
                counts[label] += 1

                if len(pending) >= 500:
                    _flush(db, pending)

            _flush(db, pending)

        summary[name] = {**counts, "total": sum(counts.values()),
                         **({"errors": errors} if errors else {})}

    db.commit()
    return {
        "emirates": summary,
        "grand_total": db.query(Place).count(),
        "at": datetime.utcnow().isoformat(),
    }
