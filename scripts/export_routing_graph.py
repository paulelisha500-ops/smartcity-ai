"""
Export the routable road graph as a compact binary for in-browser routing.

Runs *inside the backend container* (it imports the app's own graph builder so
the browser routes over exactly the graph the API routes over), and writes the
binary to stdout:

    docker compose exec -T backend python - < scripts/export_routing_graph.py > graph.bin

`scripts/snapshot_static.py` does this for you. The layout is read by
frontend/src/lib/routing.ts — keep the two in step.

    8 bytes   magic "SCRG1\\0\\0\\0"
    uint32    node count N, edge count E, geometry value count G, reserved
    int32     [2N]   node lat, lon  (degrees x 1e5)
    uint8     [N]    node flags     (bit 0: in the routable core), padded to 4
    uint32    [E]    edge from-node
    uint32    [E]    edge to-node
    float32   [E]    edge length, metres
    float32   [E]    edge travel time, seconds
    uint8     [E]    edge flags     (bits 0-3 class, bit 4 two-way, bit 5 toll), padded to 4
    uint32    [E+1]  offset of each edge's geometry in the delta array
    int16     [G]    intermediate vertices as (dlat, dlon) deltas x 1e5 from the
                     previous vertex, starting at the from-node
"""
import struct
import sys
from array import array

from app.database import SessionLocal
from app.services.road_graph import ROUTING_CLASSES, RealRoadGraph

SCALE = 100_000
INT16_MAX = 32_767


def quantise(lat: float, lon: float) -> tuple[int, int]:
    return round(lat * SCALE), round(lon * SCALE)


def padded(data: bytes) -> bytes:
    return data + b"\0" * (-len(data) % 4)


def main() -> None:
    db = SessionLocal()
    try:
        graph = RealRoadGraph().build(db, highway_classes=ROUTING_CLASSES)
    finally:
        db.close()

    index = {key: i for i, key in enumerate(graph.nodes)}
    nodes = array("i")
    node_flags = bytearray()
    for key, (lat, lon) in graph.nodes.items():
        nodes.extend(quantise(lat, lon))
        node_flags.append(1 if key in graph.main_component else 0)

    edge_from, edge_to = array("I"), array("I")
    edge_len, edge_time = array("f"), array("f")
    edge_flags = bytearray()
    geom_start = array("I")
    deltas = array("h")

    # A two-way link is stored by the builder as two edges with mirrored
    # geometry. Emit it once and flag it, which nearly halves the file.
    emitted: dict[tuple, int] = {}

    for frm, edges in graph.adjacency.items():
        for edge in edges:
            points = [quantise(lat, lon) for lat, lon in edge.geometry]
            mirror = (edge.link_id, edge.to, frm, tuple(reversed(points)))
            if mirror in emitted:
                edge_flags[emitted[mirror]] |= 0x10
                continue
            emitted[(edge.link_id, frm, edge.to, tuple(points))] = len(edge_flags)

            edge_from.append(index[frm])
            edge_to.append(index[edge.to])
            edge_len.append(edge.length_m)
            edge_time.append(edge.travel_time_s)
            edge_flags.append(ROUTING_CLASSES.index(edge.highway) | (0x20 if edge.toll else 0))
            geom_start.append(len(deltas))

            prev = (nodes[2 * index[frm]], nodes[2 * index[frm] + 1])
            for point in points[1:-1]:
                dlat, dlon = point[0] - prev[0], point[1] - prev[1]
                if dlat == 0 and dlon == 0:
                    continue
                # A single hop longer than int16 allows (~36 km) is split.
                hops = max(1, -(-max(abs(dlat), abs(dlon)) // INT16_MAX))
                for step in range(1, hops + 1):
                    deltas.extend((dlat * step // hops - dlat * (step - 1) // hops,
                                   dlon * step // hops - dlon * (step - 1) // hops))
                prev = point
    geom_start.append(len(deltas))

    out = sys.stdout.buffer
    out.write(b"SCRG1\0\0\0")
    out.write(struct.pack("<4I", len(node_flags), len(edge_flags), len(deltas), 0))
    for chunk in (nodes.tobytes(), padded(bytes(node_flags)), edge_from.tobytes(),
                  edge_to.tobytes(), edge_len.tobytes(), edge_time.tobytes(),
                  padded(bytes(edge_flags)), geom_start.tobytes(), padded(deltas.tobytes())):
        out.write(chunk)

    print(
        f"graph: {len(node_flags)} nodes ({len(graph.main_component)} routable), "
        f"{len(edge_flags)} edges, {len(deltas) // 2} shape points",
        file=sys.stderr,
    )


main()
