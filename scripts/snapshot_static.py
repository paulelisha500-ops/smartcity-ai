"""
Record a read-only snapshot of the running API for the static edition.

The Hugging Face Static Space has no server, so the frontend's static data
layer (frontend/src/lib/static-api.ts) answers every request from the files
this writes into frontend/public/data/. Run it against a backend whose
database holds the data you want published — normally the local stack, with
the network and gazetteer already ingested:

    docker compose up -d postgres redis backend
    python scripts/snapshot_static.py            # everything
    python scripts/snapshot_static.py gets graph # or just the named steps

Then build and publish the site (see docs/DEPLOYMENT.md).
"""
from __future__ import annotations

import gzip
import json
import math
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx

API = os.environ.get("SMARTCITY_API", "http://localhost:8001")
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "frontend" / "public" / "data"

# Edge length of a road tile in degrees. Small enough that the densest urban
# cell stays well under the API's 6000-row cap; the browser stitches tiles back
# together for whatever bounding box the map asks for.
CELL = 0.05

# Mirrors the constants in the pages that call these endpoints.
NETWORK_FILTERS = ["motorway", "motorway,trunk", "motorway,trunk,primary", ""]
LANES = range(2, 13)

client = httpx.Client(
    base_url=API, timeout=300,
    headers={"X-Requested-With": "smartcity-console"},
)


def canonical(path: str, params: dict | None = None) -> str:
    """Same key the browser computes: path + sorted raw k=v pairs."""
    if not params:
        return path
    return path + "?" + "&".join(sorted(f"{k}={v}" for k, v in params.items()))


def write(rel: str, payload: bytes) -> None:
    """
    Store one file of the data set, gzip-compressed. The static host applies
    no transfer compression, so the browser inflates these itself. mtime=0
    keeps the bytes identical between runs, which is what lets a deploy skip
    files that have not changed.
    """
    target = OUT / f"{rel}.gz"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(gzip.compress(payload, compresslevel=9, mtime=0))


def dump(rel: str, data) -> None:
    write(rel, json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))


def get(path: str, params: dict | None = None):
    res = client.get(path, params=params)
    res.raise_for_status()
    return res.json()


def psql_json(sql: str):
    """One JSON document straight from Postgres, for exports the API caps."""
    out = subprocess.run(
        ["docker", "compose", "exec", "-T", "postgres",
         "psql", "-U", "smartcity", "-d", "smartcity", "-At", "-c", sql],
        cwd=ROOT, capture_output=True, check=True, encoding="utf-8",
    ).stdout
    return json.loads(out) if out.strip() else []


def record_gets() -> None:
    manifest: dict[str, str] = {}
    targets: list[tuple[str, dict | None]] = [
        # Traffic readings are not recorded: they are a deterministic function
        # of (junction, hour), which the browser evaluates for the current hour.
        ("/api/traffic/intersections", None),
        ("/api/complaints", None),
        ("/api/digital-twin/layers", None),
        ("/api/analytics/kpis", None),
        ("/api/analytics/history/complaints", {"days": 30}),
        ("/api/cameras", None),
        ("/api/cameras/summary", None),
        ("/api/cameras/integration-guide", None),
        ("/api/network/status", None),
        ("/api/network/border-crossings", None),
        ("/api/network/corridors", None),
        ("/api/network/streets", {"limit": 200}),
        ("/api/network/roads", {"highway": "motorway,trunk", "limit": 500}),
        ("/api/places/status", None),
        ("/api/places", {"limit": 1200}),
        ("/api/places", {"category": "place", "limit": 400}),
        ("/api/infrastructure/projects", None),
        ("/api/infrastructure/bridges", None),
        ("/api/infrastructure/summary", None),
        ("/api/route-design/presets", None),
        ("/api/route-design/proposals", None),
    ]
    for highway in NETWORK_FILTERS:
        for intl in (False, True):
            params: dict = {"limit": 1200}
            if highway:
                params["highway"] = highway
            if intl:
                params["international_only"] = "true"
            targets.append(("/api/network/roads", params))

    for i, (path, params) in enumerate(targets):
        rel = f"get/{i:02d}-{path.strip('/').replace('/', '-')}.json"
        data = get(path, params)
        if path == "/api/network/roads":
            # ~1 m is finer than the map can draw; full precision is a fifth
            # more bytes for nothing.
            data = [_round_geometry(link) for link in data]
        dump(rel, data)
        manifest[canonical(path, params)] = rel

    # A ranked list the pages ask for at several lengths: record the long form
    # once and let the browser slice it.
    dump("get/road-damage-priority.json", get("/api/road-damage/priority", {"limit": 100}))
    dump("manifest.json", manifest)
    print(f"recorded {len(targets) + 1} GET responses")


def record_route_designs() -> None:
    presets = get("/api/route-design/presets")

    jobs = [(p, n) for p in presets for n in LANES]
    for preset, lanes in jobs:
        payload = {
            "origin_lat": preset["origin_lat"], "origin_lon": preset["origin_lon"],
            "dest_lat": preset["dest_lat"], "dest_lon": preset["dest_lon"],
            "origin_name": preset["origin_name"],
            "destination_name": preset["destination_name"],
            "lanes": lanes,
        }
        while True:
            res = client.post("/api/route-design/analyze", json=payload)
            if res.status_code != 429:
                break
            # The endpoint is rate limited; wait out the window it reports.
            time.sleep(int(res.headers.get("Retry-After", "5")) + 1)
        res.raise_for_status()
        dump(f"route-design/{preset['id']}-{lanes}.json", res.json())
    print(f"recorded {len(jobs)} route designs")


def _round_geometry(link: dict) -> dict:
    link.pop("osm_id", None)
    link["geometry"] = [[round(lat, 5), round(lon, 5)] for lat, lon in link["geometry"]]
    return link


def record_road_tiles() -> None:
    south, north, west, east = psql_json(
        "select json_build_array(min(ST_YMin(geom)), max(ST_YMax(geom)),"
        " min(ST_XMin(geom)), max(ST_XMax(geom))) from road_link"
    )
    cells = [
        (iy, ix)
        for iy in range(math.floor(south / CELL), math.floor(north / CELL) + 1)
        for ix in range(math.floor(west / CELL), math.floor(east / CELL) + 1)
    ]

    def one(cell):
        iy, ix = cell
        bbox = f"{iy * CELL:.5f},{ix * CELL:.5f},{(iy + 1) * CELL:.5f},{(ix + 1) * CELL:.5f}"
        links = get("/api/network/roads", {"bbox": bbox, "limit": 6000})
        if not links:
            return None
        if len(links) >= 6000:
            print(f"  warning: tile {iy}_{ix} hit the 6000-row cap", file=sys.stderr)
        dump(f"roads/{iy}_{ix}.json", [_round_geometry(l) for l in links])
        return f"{iy}_{ix}"

    with ThreadPoolExecutor(8) as pool:
        written = [name for name in pool.map(one, cells) if name]
    dump("roads/index.json", {"cell": CELL, "tiles": sorted(written)})
    print(f"wrote {len(written)} road tiles (of {len(cells)} cells scanned)")


def record_search_index() -> None:
    # Arrays rather than objects: 17k places and 13k streets, loaded in one go
    # the first time someone searches.
    places = psql_json(
        "select coalesce(json_agg(json_build_array(id, name, name_ar, category, subcategory,"
        " emirate, round(ST_Y(geom)::numeric, 6), round(ST_X(geom)::numeric, 6),"
        " population, importance) order by importance desc), '[]') from gazetteer_place"
    )
    streets = psql_json(
        "select coalesce(json_agg(json_build_array(name, ref, emirate, round(total_len::numeric, 1),"
        " round(lat::numeric, 6), round(lon::numeric, 6))), '[]') from ("
        " select name, ref, emirate, sum(length_m) as total_len,"
        " ST_Y(ST_Centroid(ST_Collect(geom))) as lat, ST_X(ST_Centroid(ST_Collect(geom))) as lon"
        " from road_link where name is not null group by name, ref, emirate) s"
        " where lat is not null"
    )
    dump("search/places.json", places)
    dump("search/streets.json", streets)
    print(f"indexed {len(places)} places and {len(streets)} streets for search")


def record_actions() -> None:
    """
    Console actions whose outcome is fixed by the published data set: seeding a
    register that is already seeded, and probing camera sites that are
    placeholders awaiting a real device. Recorded so the buttons report what
    the server reports.
    """
    def post(path: str):
        res = client.post(path)
        res.raise_for_status()
        return res.json()

    dump("actions/cameras-seed-sites.json", post("/api/cameras/seed-sites"))
    dump("actions/infrastructure-seed.json", post("/api/infrastructure/seed"))
    cameras = get("/api/cameras")
    for camera in cameras:
        dump(f"actions/camera-test-{camera['id']}.json", post(f"/api/cameras/{camera['id']}/test"))
    dump("actions/cameras-health-sweep.json", post("/api/cameras/health-sweep"))
    print(f"recorded {len(cameras) + 3} console actions")


def export_routing_graph() -> None:
    """The API's own routing graph, for route design in the browser."""
    script = (ROOT / "scripts" / "export_routing_graph.py").read_bytes()
    done = subprocess.run(
        ["docker", "compose", "exec", "-T", "backend", "python", "-"],
        cwd=ROOT, input=script, capture_output=True, check=True,
    )
    write("routing/graph.bin", done.stdout)
    print(done.stderr.decode(errors="replace").strip().splitlines()[-1])


STEPS = {
    # Actions first: a camera probe updates the fleet record the GETs then read.
    "actions": None, "gets": None, "search": None,
    "designs": None, "graph": None, "tiles": None,
}


def main() -> None:
    login = client.post("/api/auth/login", json={
        "email": "admin@city.gov",
        "password": os.environ.get("SMARTCITY_ACCOUNT_PASSWORD", "smartcity"),
    })
    login.raise_for_status()

    STEPS.update(
        actions=record_actions, gets=record_gets,
        search=record_search_index, designs=record_route_designs,
        graph=export_routing_graph, tiles=record_road_tiles,
    )
    wanted = sys.argv[1:] or list(STEPS)
    unknown = [name for name in wanted if name not in STEPS]
    if unknown:
        sys.exit(f"unknown step(s) {unknown}; choose from {list(STEPS)}")
    if not sys.argv[1:] and OUT.exists():
        shutil.rmtree(OUT)
    for name in wanted:
        STEPS[name]()

    size = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file())
    print(f"snapshot written to {OUT} ({size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
