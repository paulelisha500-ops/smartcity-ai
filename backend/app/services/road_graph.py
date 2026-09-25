"""
M7 (upgraded) — routing over the real UAE road network.

The original POC routed over a five-node demo graph. This module builds a
routable graph from the actual OSM `road_link` geometry in PostGIS and runs
A* across it, so an ambulance route is computed on the roads that exist.

Graph construction joins links by **endpoint coordinate**, not by OSM node id.
That sounds like a detail but it matters: node ids are only present when the
Overpass response includes them, and a coordinate join additionally stitches
together links that meet geometrically but were split across separate ways.
Endpoints are quantised to ~1.1m (5 decimal places), which is well inside GPS
error and far below lane width, so it joins real junctions without fusing
parallel carriageways.

Edge cost is **travel time**, not distance — the whole point of a live traffic
platform is that the fastest route changes when a road jams up. Congestion
scores written by M1 feed straight into the effective speed.
"""
from __future__ import annotations

import heapq
import math
import threading
from dataclasses import dataclass
from typing import Optional

from geoalchemy2.shape import to_shape
from sqlalchemy.orm import Session

from app.models.network import RoadLink
from app.services.osm_network import haversine_km

# Fallback speeds (km/h) when OSM has no maxspeed tag for a link.
DEFAULT_SPEEDS = {
    "motorway": 120, "motorway_link": 80,
    "trunk": 100, "trunk_link": 70,
    "primary": 80, "primary_link": 60,
    "secondary": 60, "secondary_link": 50,
    "tertiary": 50, "residential": 40, "unclassified": 40,
}

# How much a fully congested link slows you down. 0.75 means a 100 km/h road
# at congestion 100 behaves like a 25 km/h road.
MAX_CONGESTION_PENALTY = 0.75

NODE_PRECISION = 5  # decimal places ≈ 1.1 m


@dataclass
class Edge:
    to: str
    link_id: int
    length_m: float
    travel_time_s: float
    name: Optional[str]
    ref: Optional[str]
    highway: str
    toll: bool
    geometry: list[tuple[float, float]]  # [(lat, lon), ...] in travel direction


def node_key(lat: float, lon: float) -> str:
    return f"{round(lat, NODE_PRECISION)},{round(lon, NODE_PRECISION)}"


def effective_speed_kmh(link: RoadLink) -> float:
    base = link.maxspeed_kmh or DEFAULT_SPEEDS.get(link.highway, 50)
    congestion = min(max(link.congestion_score or 0.0, 0.0), 100.0)
    return max(5.0, base * (1.0 - MAX_CONGESTION_PENALTY * congestion / 100.0))


class RealRoadGraph:
    """An in-memory routable view of the PostGIS road network."""

    def __init__(self):
        self.adjacency: dict[str, list[Edge]] = {}
        self.nodes: dict[str, tuple[float, float]] = {}
        self.built_at: Optional[float] = None
        self.link_count = 0
        # The routable core of the network — see `_compute_main_component`.
        self.main_component: set[str] = set()

    # -- construction -------------------------------------------------------
    def build(self, db: Session, highway_classes: Optional[list[str]] = None) -> "RealRoadGraph":
        """
        Build a routable graph by splitting ways at every shared vertex.

        The naive approach — one edge per OSM way, joined only where way
        *endpoints* coincide — produces a graph that looks plausible and barely
        connects. OSM ways are not drawn junction-to-junction: a slip road
        typically meets a motorway at a vertex partway along the motorway way,
        and a way often runs through several junctions before it ends. Keying
        only on endpoints makes every one of those junctions invisible, which
        shatters the network into thousands of components and makes A* report
        "no route" between roads that visibly cross on the map.

        So we do what a real OSM routing importer does:

        1. Count how many ways use each vertex coordinate.
        2. Treat a vertex as a *junction node* if two or more ways share it, or
           if it is a way endpoint.
        3. Cut every way into segments between consecutive junction nodes, and
           make each segment an edge.

        Coordinates are quantised to ~1.1 m (5 dp), inside GPS error and well
        below lane width, so genuine junctions merge while parallel
        carriageways stay separate.
        """
        self.adjacency.clear()
        self.nodes.clear()

        query = db.query(RoadLink)
        if highway_classes:
            query = query.filter(RoadLink.highway.in_(highway_classes))

        # --- pass 1: which vertices are shared between ways? ---------------
        geometries: list[tuple[RoadLink, list[tuple[float, float]]]] = []
        vertex_uses: dict[str, int] = {}

        for link in query.yield_per(1000):
            try:
                line = to_shape(link.geom)
            except Exception:
                continue
            coords = list(line.coords)  # shapely gives (lon, lat)
            if len(coords) < 2:
                continue
            points = [(lat, lon) for lon, lat in coords]
            geometries.append((link, points))

            # A vertex repeated inside one way (a loop) still only counts once
            # for that way, so use a per-way set.
            for key in {node_key(lat, lon) for lat, lon in points}:
                vertex_uses[key] = vertex_uses.get(key, 0) + 1

        # --- pass 2: cut each way at its junction vertices ------------------
        count = 0
        for link, points in geometries:
            speed = effective_speed_kmh(link)

            cut_indices = [
                i for i, (lat, lon) in enumerate(points)
                if i == 0 or i == len(points) - 1 or vertex_uses.get(node_key(lat, lon), 0) > 1
            ]

            for start_i, end_i in zip(cut_indices, cut_indices[1:]):
                segment = points[start_i:end_i + 1]
                if len(segment) < 2:
                    continue

                a = node_key(*segment[0])
                b = node_key(*segment[-1])
                if a == b:
                    continue

                self.nodes.setdefault(a, segment[0])
                self.nodes.setdefault(b, segment[-1])

                length = sum(
                    haversine_km(p[0], p[1], q[0], q[1]) * 1000
                    for p, q in zip(segment, segment[1:])
                )
                if length <= 0:
                    continue
                time_s = (length / 1000.0) / speed * 3600.0

                self._add(a, Edge(b, link.id, length, time_s, link.name, link.ref,
                                  link.highway, bool(link.toll), segment))
                if not link.oneway:
                    self._add(b, Edge(a, link.id, length, time_s, link.name, link.ref,
                                      link.highway, bool(link.toll), list(reversed(segment))))
            count += 1

        self.link_count = count
        self._compute_main_component()
        self.built_at = __import__("time").time()
        return self

    def _compute_main_component(self) -> None:
        """
        Cache the largest **strongly** connected component — the drivable core.

        A weakly-connected component is not good enough here. Almost every UAE
        motorway and trunk road is a dual carriageway, mapped as two separate
        `oneway=yes` ways, so the directed graph is full of places you can
        reach but not leave (and vice versa). Snapping to a weakly-connected
        node therefore still yields "no route found": the origin sits on a
        carriageway heading away from the destination with no modelled way to
        turn around.

        In a strongly connected component every node can reach every other by
        following one-way restrictions, so snapping both ends into the largest
        SCC guarantees a route exists. This is the same guarantee OSRM and
        Valhalla give by pruning to the largest SCC at build time.

        Kosaraju's algorithm, written iteratively — a recursive DFS blows the
        stack at ~33k nodes.
        """
        # --- pass 1: order nodes by DFS finish time ------------------------
        visited: set[str] = set()
        order: list[str] = []

        for start in self.adjacency:
            if start in visited:
                continue
            # (node, expanded?) — the flag marks the post-visit step.
            stack: list[tuple[str, bool]] = [(start, False)]
            while stack:
                node, expanded = stack.pop()
                if expanded:
                    order.append(node)
                    continue
                if node in visited:
                    continue
                visited.add(node)
                stack.append((node, True))
                for edge in self.adjacency.get(node, ()):
                    if edge.to not in visited:
                        stack.append((edge.to, False))

        # --- build the reverse graph ---------------------------------------
        reverse: dict[str, list[str]] = {}
        for frm, edges in self.adjacency.items():
            for edge in edges:
                reverse.setdefault(edge.to, []).append(frm)

        # --- pass 2: DFS the reverse graph in reverse finish order ---------
        assigned: set[str] = set()
        best: set[str] = set()

        for node in reversed(order):
            if node in assigned:
                continue
            group = {node}
            assigned.add(node)
            stack2 = [node]
            while stack2:
                current = stack2.pop()
                for prev in reverse.get(current, ()):
                    if prev not in assigned:
                        assigned.add(prev)
                        group.add(prev)
                        stack2.append(prev)
            if len(group) > len(best):
                best = group

        self.main_component = best

    def _add(self, frm: str, edge: Edge) -> None:
        self.adjacency.setdefault(frm, []).append(edge)

    @property
    def is_empty(self) -> bool:
        return not self.adjacency

    # -- diagnostics --------------------------------------------------------
    def components(self, top: int = 5) -> dict:
        """
        Size of the connected components, treating edges as undirected.

        This is the metric that explains routing failures. A road network
        ingested without `_link` slip roads shatters into thousands of tiny
        components — every carriageway is present but nothing joins them, so
        A* correctly reports "no route" between points that are physically a
        few hundred metres apart. If `largest_component_pct` is low, ingest the
        link classes rather than debugging the search.
        """
        # Undirected adjacency: a one-way link still physically connects its
        # endpoints, and connectivity here is about reachability of the graph,
        # not legal direction of travel.
        undirected: dict[str, set[str]] = {}
        for frm, edges in self.adjacency.items():
            undirected.setdefault(frm, set())
            for edge in edges:
                undirected[frm].add(edge.to)
                undirected.setdefault(edge.to, set()).add(frm)

        seen: set[str] = set()
        sizes: list[int] = []
        for start in undirected:
            if start in seen:
                continue
            stack = [start]
            seen.add(start)
            size = 0
            while stack:
                node = stack.pop()
                size += 1
                for nxt in undirected.get(node, ()):
                    if nxt not in seen:
                        seen.add(nxt)
                        stack.append(nxt)
            sizes.append(size)

        sizes.sort(reverse=True)
        total = sum(sizes) or 1
        return {
            "component_count": len(sizes),
            "largest_component": sizes[0] if sizes else 0,
            "largest_component_pct": round((sizes[0] if sizes else 0) / total * 100, 1),
            "top_components": sizes[:top],
        }

    # -- queries ------------------------------------------------------------
    def nearest_node(self, lat: float, lon: float, routable_only: bool = True) -> Optional[str]:
        """
        Snap a free coordinate onto the network.

        By default only the routable core is considered (see
        `_compute_main_component`), because the closest node is frequently a
        dead-end stub or a one-way sink from which no journey can start.

        Linear scan over node coordinates: at UAE strategic-network size
        (tens of thousands of nodes) this is a few milliseconds, and it avoids
        carrying an R-tree dependency. Swap for PostGIS `ST_DWithin` against a
        GiST index if the network grows to full residential detail.
        """
        candidates = (
            self.main_component if routable_only and self.main_component else self.nodes.keys()
        )

        best, best_d = None, float("inf")
        for key in candidates:
            nlat, nlon = self.nodes[key]
            # Cheap planar prefilter before the trigonometric distance.
            if abs(nlat - lat) > 0.5 or abs(nlon - lon) > 0.5:
                continue
            d = (nlat - lat) ** 2 + (nlon - lon) ** 2
            if d < best_d:
                best, best_d = key, d

        # Fall back to the whole graph rather than refusing to route at all.
        if best is None and routable_only:
            return self.nearest_node(lat, lon, routable_only=False)
        return best

    def astar(self, start: str, goal: str, avoid_tolls: bool = False,
              max_expansions: int = 400_000) -> Optional[dict]:
        """
        A* with a haversine time-to-goal heuristic.

        The heuristic divides straight-line distance by the fastest speed on
        the network (120 km/h), which keeps it admissible — it can never
        overestimate the true remaining time, so the first path we pop is
        optimal.
        """
        if start not in self.adjacency or goal not in self.nodes:
            return None

        goal_lat, goal_lon = self.nodes[goal]

        def h(key: str) -> float:
            lat, lon = self.nodes[key]
            return haversine_km(lat, lon, goal_lat, goal_lon) / 120.0 * 3600.0

        g: dict[str, float] = {start: 0.0}
        came: dict[str, tuple[str, Edge]] = {}
        visited: set[str] = set()
        heap: list[tuple[float, str]] = [(h(start), start)]
        expansions = 0

        while heap:
            _, node = heapq.heappop(heap)
            if node in visited:
                continue
            visited.add(node)
            expansions += 1
            if expansions > max_expansions:
                return None
            if node == goal:
                return self._reconstruct(came, start, goal, g[goal])

            for edge in self.adjacency.get(node, []):
                if avoid_tolls and edge.toll:
                    continue
                tentative = g[node] + edge.travel_time_s
                if tentative < g.get(edge.to, float("inf")):
                    g[edge.to] = tentative
                    came[edge.to] = (node, edge)
                    heapq.heappush(heap, (tentative + h(edge.to), edge.to))

        return None

    def _reconstruct(self, came, start: str, goal: str, total_time: float) -> dict:
        path_nodes: list[str] = [goal]
        geometry: list[tuple[float, float]] = []
        steps: list[dict] = []
        distance = 0.0
        tolls = 0

        cursor = goal
        while cursor != start:
            prev, edge = came[cursor]
            geometry.append(edge.geometry)
            distance += edge.length_m
            if edge.toll:
                tolls += 1
            steps.append({
                "road": edge.name or edge.ref or edge.highway.replace("_", " "),
                "ref": edge.ref,
                "distance_m": round(edge.length_m, 1),
                "time_s": round(edge.travel_time_s, 1),
                "toll": edge.toll,
            })
            path_nodes.append(prev)
            cursor = prev

        geometry.reverse()
        steps.reverse()
        path_nodes.reverse()

        # Flatten per-edge geometry, dropping the duplicated join vertex.
        flat: list[tuple[float, float]] = []
        for seg in geometry:
            if flat and seg and flat[-1] == seg[0]:
                flat.extend(seg[1:])
            else:
                flat.extend(seg)

        return {
            "geometry": [[lat, lon] for lat, lon in flat],
            "distance_m": round(distance, 1),
            "eta_seconds": round(total_time, 1),
            "toll_segments": tolls,
            "steps": _merge_steps(steps),
            "node_count": len(path_nodes),
        }


def _merge_steps(steps: list[dict]) -> list[dict]:
    """Collapse consecutive edges on the same road into one turn-by-turn step."""
    merged: list[dict] = []
    for step in steps:
        if merged and merged[-1]["road"] == step["road"]:
            merged[-1]["distance_m"] = round(merged[-1]["distance_m"] + step["distance_m"], 1)
            merged[-1]["time_s"] = round(merged[-1]["time_s"] + step["time_s"], 1)
            merged[-1]["toll"] = merged[-1]["toll"] or step["toll"]
        else:
            merged.append(dict(step))
    return merged


# --------------------------------------------------------------------------
# Cached singleton — building the graph costs a few seconds, so we do it once
# and rebuild only when the network is re-ingested or congestion is refreshed.
# --------------------------------------------------------------------------
#
# Classes the router traverses. Once the full street network is imported the
# database holds several hundred thousand links, most of them residential and
# service roads. Building the in-memory graph over all of them would consume
# more RAM than this stack has and slow every route for no strategic benefit —
# inter-city and emergency routing runs on the arterial network.
#
# Residential and service roads stay in the database: they are drawn on the
# map and searched by the geocoder, they just are not loaded into the router.
# Widen this list when last-metre routing to a specific address is needed and
# there is memory to spare.
#
ROUTING_CLASSES = [
    "motorway", "motorway_link",
    "trunk", "trunk_link",
    "primary", "primary_link",
    "secondary", "secondary_link",
    "tertiary", "tertiary_link",
]


class GraphCache:
    def __init__(self):
        self._graph: Optional[RealRoadGraph] = None
        self._lock = threading.Lock()

    def get(self, db: Session, rebuild: bool = False,
            classes: Optional[list[str]] = None) -> RealRoadGraph:
        with self._lock:
            if self._graph is None or rebuild:
                self._graph = RealRoadGraph().build(
                    db, highway_classes=classes or ROUTING_CLASSES
                )
            return self._graph

    def invalidate(self) -> None:
        with self._lock:
            self._graph = None


graph_cache = GraphCache()


def route_between(db: Session, origin: tuple[float, float], destination: tuple[float, float],
                  avoid_tolls: bool = False, emergency: bool = False) -> dict:
    """
    Route two coordinates over the real network.

    `emergency` applies a blue-light factor: emergency vehicles get priority at
    junctions and may use hard shoulders, so real-world ambulance travel times
    run roughly 20-30% under civilian times on the same geometry. We model the
    conservative end of that.
    """
    graph = graph_cache.get(db)
    if graph.is_empty:
        return {
            "reachable": False,
            "error": "road network not ingested yet — POST /api/network/ingest first",
        }

    start = graph.nearest_node(*origin)
    goal = graph.nearest_node(*destination)
    if not start or not goal:
        return {"reachable": False, "error": "could not snap coordinates to the road network"}

    result = graph.astar(start, goal, avoid_tolls=avoid_tolls)
    if not result:
        return {"reachable": False, "error": "no route found between these points"}

    if emergency:
        result["civilian_eta_seconds"] = result["eta_seconds"]
        result["eta_seconds"] = round(result["eta_seconds"] * 0.75, 1)
        result["emergency_priority"] = True

    result["reachable"] = True
    result["snapped_origin"] = list(graph.nodes[start])
    result["snapped_destination"] = list(graph.nodes[goal])
    result["network_links"] = graph.link_count

    # How far each requested point was from the node we actually routed from.
    # Snapping is restricted to the strongly-connected core, so where a local
    # street network isn't joined to it the nearest usable node can be
    # kilometres away — and the route then silently stops short (or starts
    # late). A route that doesn't reach the address has to say so.
    origin_snap_m = haversine_km(*origin, *graph.nodes[start]) * 1000.0
    dest_snap_m = haversine_km(*destination, *graph.nodes[goal]) * 1000.0
    result["origin_snap_m"] = round(origin_snap_m, 1)
    result["destination_snap_m"] = round(dest_snap_m, 1)

    if max(origin_snap_m, dest_snap_m) > SNAP_WARN_M:
        worst = "destination" if dest_snap_m >= origin_snap_m else "origin"
        result["warning"] = (
            f"The {worst} is {max(origin_snap_m, dest_snap_m) / 1000:.1f} km from the "
            "nearest connected road; the route ends at that point, not at the address. "
            "The local street network there is not joined to the main network in the "
            "imported data."
        )
    return result


# Beyond this, a snapped endpoint is far enough from the request to mislead.
SNAP_WARN_M = 1500.0
