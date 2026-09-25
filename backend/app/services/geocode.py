"""
Geocoding — turn a name into a coordinate, and a coordinate into a name.

Searches two sources and merges them: the `place` gazetteer (cities, districts,
named buildings, amenities) and `road_link.name` (every named street in the
imported network). A user typing "Sheikh Zayed" means the road; typing "Rashid
Hospital" means the building — so both have to be searchable from one box.

Ranking combines textual similarity with a precomputed importance weight, so
"Dubai" returns the emirate rather than a shop of the same name.
"""
from __future__ import annotations

from typing import Optional

from geoalchemy2.shape import to_shape
from sqlalchemy import func, or_, text
from sqlalchemy.orm import Session

from app.models.place import Place
from app.models.network import RoadLink
from app.services.osm_network import haversine_km


def _clean(term: str) -> str:
    return " ".join((term or "").strip().split())[:120]


def _rank(sim: float, importance: float, name: str, needle: str, tokens: list[str]) -> float:
    """
    Relevance first, prominence second.

    * Text similarity is the base, 0-100.
    * Containing the whole query as a phrase is the strongest signal a user
      meant this feature ("dubai mall" inside "the dubai mall"), worth +30.
    * Containing every query word, in any order, is worth +15.
    * An exact name match is worth a further +25.
    * Importance is then capped at 40 and scaled to at most +16, so it breaks
      ties between comparable matches without ever outvoting the text. That
      is what stops a million-person city from beating a mall the user
      named precisely.
    """
    score = sim * 100.0
    if needle and needle in name:
        score += 30.0
    if tokens and all(t in name for t in tokens):
        score += 15.0
    if name == needle:
        score += 25.0
    score += min(importance, 40.0) * 0.4
    return round(score, 2)


def search(db: Session, term: str, limit: int = 12,
           emirate: Optional[str] = None,
           category: Optional[str] = None,
           near: Optional[tuple[float, float]] = None) -> list[dict]:
    """
    Fuzzy search across places and street names.

    Uses pg_trgm similarity rather than plain ILIKE so transliteration variants
    still match — "Al Maktoum", "Al-Maktoum" and "Almaktoum" should all find
    the same bridge, which a substring match would not do.
    """
    term = _clean(term)
    if len(term) < 2:
        return []

    pattern = f"%{term}%"
    results: list[dict] = []

    # ---- places -----------------------------------------------------------
    similarity = func.similarity(Place.name, term)
    q = db.query(Place, similarity.label("sim")).filter(
        or_(
            Place.name.ilike(pattern),
            Place.name_ar.ilike(pattern),
            similarity > 0.22,
        )
    )
    if emirate:
        q = q.filter(Place.emirate == emirate)
    if category:
        q = q.filter(Place.category == category)

    # Pull a generous candidate set by raw text similarity, then rank in Python
    # where the scoring can be explained. Ordering by `sim + importance` in SQL
    # was wrong: importance runs to 160 for a city while similarity tops out at
    # 100, so "Dubai Mall" returned the emirate "Dubai" above The Dubai Mall.
    needle = term.lower()
    tokens = [t for t in needle.split() if len(t) > 1]

    for place, sim in q.order_by(similarity.desc()).limit(limit * 6).all():
        point = to_shape(place.geom)
        name_l = (place.name or "").lower()
        results.append({
            "type": "place",
            "id": place.id,
            "name": place.name,
            "name_ar": place.name_ar,
            "category": place.category,
            "subcategory": place.subcategory,
            "emirate": place.emirate,
            "lat": point.y,
            "lon": point.x,
            "population": place.population,
            # Tie-break: an exact, case-sensitive match on the user's spelling
            # usually identifies the canonical, well-maintained feature —
            # "Rashid Hospital" (Dubai's trauma centre) over a "Rashid hospital"
            # that otherwise scores identically.
            "score": _rank(float(sim or 0), place.importance or 0.0, name_l, needle, tokens)
                     + (1.0 if place.name == term else 0.0),
        })

    # ---- streets ----------------------------------------------------------
    # One row per distinct street name: OSM splits a road into many ways and a
    # search result list showing "Sheikh Zayed Road" forty times is useless.
    street_sim = func.similarity(RoadLink.name, term)
    sq = (
        db.query(
            RoadLink.name,
            RoadLink.ref,
            RoadLink.emirate,
            func.max(street_sim).label("sim"),
            func.sum(RoadLink.length_m).label("total_len"),
            func.ST_Y(func.ST_Centroid(func.ST_Collect(RoadLink.geom))).label("lat"),
            func.ST_X(func.ST_Centroid(func.ST_Collect(RoadLink.geom))).label("lon"),
        )
        .filter(RoadLink.name.isnot(None))
        .filter(or_(RoadLink.name.ilike(pattern), street_sim > 0.3))
    )
    if emirate:
        sq = sq.filter(RoadLink.emirate == emirate)

    if not category or category == "street":
        # A query that names a road type is asking for the road, not for the
        # neighbourhood or tower block that shares its name — Dubai has a
        # district, a building and a highway all called "Sheikh Zayed Road".
        road_words = {"road", "rd", "street", "st", "highway", "hwy",
                      "avenue", "ave", "boulevard", "blvd", "corniche"}
        road_intent = any(w.strip(".,") in road_words for w in needle.split())

        for row in (
            sq.group_by(RoadLink.name, RoadLink.ref, RoadLink.emirate)
              .order_by(func.max(street_sim).desc())
              .limit(limit).all()
        ):
            if row.lat is None:
                continue
            length_km = (row.total_len or 0) / 1000.0
            # Streets were previously scored as similarity + a flat 25, so they
            # never received the phrase and exact-match bonuses places get and
            # lost to any same-named place. Scoring them through the same
            # _rank keeps the two lists comparable. Length stands in for
            # prominence: an arterial outranks a same-named cul-de-sac.
            importance = min(40.0, 20.0 + length_km / 5.0)
            score = _rank(float(row.sim or 0), importance,
                          (row.name or "").lower(), needle, tokens)
            if road_intent:
                score += 12.0
            results.append({
                "type": "street",
                "id": None,
                "name": row.name,
                "ref": row.ref,
                "category": "street",
                "subcategory": "road",
                "emirate": row.emirate,
                "lat": row.lat,
                "lon": row.lon,
                "length_km": round(length_km, 2),
                "score": round(score, 2),
            })

    # ---- collapse duplicates ----------------------------------------------
    # The same feature legitimately arrives more than once: OSM tags a named
    # hospital as both an amenity and a building, tiled imports overlap at
    # edges, and a re-import can interleave with an in-flight one. Showing the
    # user "Dubai Land" three times is never right, so fold on name plus a
    # ~100 m position bucket and keep the best-scoring copy.
    deduped: dict[tuple, dict] = {}
    for r in results:
        if r["type"] == "street":
            # A long road is split across several (name, ref) groups — one
            # section tagged E11, another with no ref — whose centroids sit
            # kilometres apart, so a position bucket never merges them and
            # "Sheikh Zayed Road" is listed twice. One entry per name per
            # emirate is what a person searching for a road expects.
            key = ("street", r["name"].strip().lower(), r.get("emirate"))
        else:
            key = (r["name"].strip().lower(), round(r["lat"], 3), round(r["lon"], 3))
        if key not in deduped or r["score"] > deduped[key]["score"]:
            deduped[key] = r
    results = list(deduped.values())

    # ---- merge ------------------------------------------------------------
    if near:
        # Proximity bonus: when the caller has a map centre, nearby answers are
        # usually the intended ones.
        for r in results:
            d = haversine_km(near[0], near[1], r["lat"], r["lon"])
            r["distance_km"] = round(d, 2)
            r["score"] = round(r["score"] + max(0.0, 25.0 - d / 4.0), 2)

    results.sort(key=lambda r: r["score"], reverse=True)
    return results[:limit]


def reverse(db: Session, lat: float, lon: float, radius_m: float = 1500) -> dict:
    """
    What is at this coordinate? Returns the nearest named place and the nearest
    street — the two things that make a location legible to a human.
    """
    point = func.ST_SetSRID(func.ST_MakePoint(lon, lat), 4326)
    # ST_DistanceSphere returns metres directly. Casting the geometry columns
    # to geography would also work but costs a per-row cast; ST_DWithin still
    # filters in degrees against the spatial index first, so the expensive
    # distance is only computed for candidates already near the point.
    deg = radius_m / 111_320.0

    nearest_place = (
        db.query(Place, func.ST_DistanceSphere(Place.geom, point).label("d"))
        .filter(func.ST_DWithin(Place.geom, point, deg))
        .order_by(func.ST_DistanceSphere(Place.geom, point))
        .first()
    )

    nearest_road = (
        db.query(RoadLink, func.ST_DistanceSphere(RoadLink.geom, point).label("d"))
        .filter(func.ST_DWithin(RoadLink.geom, point, deg))
        .filter(RoadLink.name.isnot(None))
        .order_by(func.ST_DistanceSphere(RoadLink.geom, point))
        .first()
    )

    out: dict = {"query": {"lat": lat, "lon": lon}}

    if nearest_place:
        place, dist = nearest_place
        p = to_shape(place.geom)
        out["place"] = {
            "name": place.name, "category": place.category,
            "subcategory": place.subcategory, "emirate": place.emirate,
            "lat": p.y, "lon": p.x, "distance_m": round(float(dist), 1),
        }

    if nearest_road:
        road, dist = nearest_road
        out["street"] = {
            "name": road.name, "ref": road.ref, "highway": road.highway,
            "emirate": road.emirate, "distance_m": round(float(dist), 1),
        }

    if "place" not in out and "street" not in out:
        out["error"] = f"nothing named within {radius_m:.0f} m"
    else:
        bits = [out.get("street", {}).get("name"), out.get("place", {}).get("name"),
                (out.get("street") or out.get("place", {})).get("emirate")]
        # The nearest named place is often the city itself, which then repeats
        # the emirate: "Tawi Kiwakib Street, Abu Dhabi, Abu Dhabi". Keep the
        # first occurrence of each part.
        seen: set[str] = set()
        parts: list[str] = []
        for b in bits:
            if b and b.lower() not in seen:
                seen.add(b.lower())
                parts.append(b)
        out["label"] = ", ".join(parts)

    return out


def nearby(db: Session, lat: float, lon: float, category: Optional[str] = None,
           subcategory: Optional[str] = None, radius_km: float = 5.0,
           limit: int = 25) -> list[dict]:
    """Named features around a point — 'hospitals within 5 km of here'."""
    point = func.ST_SetSRID(func.ST_MakePoint(lon, lat), 4326)
    deg = (radius_km * 1000) / 111_320.0

    q = (
        db.query(Place, func.ST_DistanceSphere(Place.geom, point).label("d"))
        .filter(func.ST_DWithin(Place.geom, point, deg))
    )
    if category:
        q = q.filter(Place.category == category)
    if subcategory:
        q = q.filter(Place.subcategory == subcategory)

    out = []
    for place, dist in q.order_by(func.ST_DistanceSphere(Place.geom, point)).limit(limit).all():
        p = to_shape(place.geom)
        out.append({
            "id": place.id, "name": place.name, "name_ar": place.name_ar,
            "category": place.category, "subcategory": place.subcategory,
            "emirate": place.emirate, "lat": p.y, "lon": p.x,
            "distance_km": round(float(dist) / 1000.0, 2),
        })
    return out
