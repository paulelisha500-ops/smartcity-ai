"""
Emergency Routing (Module 7).

This is real, working shortest-path routing (Dijkstra) over the road graph —
not a mock. The only thing that changes in production is where edge weights
come from: today they're static (distance / speed limit); in production
they're updated in near-real-time from `TrafficCVService` congestion scores,
so an ambulance route recalculates when a road ahead jams up.
"""
import heapq
from dataclasses import dataclass


@dataclass
class Edge:
    to: str
    weight_seconds: float


class RoadGraph:
    def __init__(self):
        self.adjacency: dict[str, list[Edge]] = {}

    def add_edge(self, a: str, b: str, weight_seconds: float, bidirectional: bool = True):
        self.adjacency.setdefault(a, []).append(Edge(b, weight_seconds))
        if bidirectional:
            self.adjacency.setdefault(b, []).append(Edge(a, weight_seconds))

    def update_weight(self, a: str, b: str, weight_seconds: float):
        """Called when TrafficCVService reports a new congestion score for the segment a-b."""
        for edge in self.adjacency.get(a, []):
            if edge.to == b:
                edge.weight_seconds = weight_seconds
        for edge in self.adjacency.get(b, []):
            if edge.to == a:
                edge.weight_seconds = weight_seconds


class EmergencyRoutingService:
    def shortest_path(self, graph: RoadGraph, start: str, end: str) -> dict:
        distances: dict[str, float] = {start: 0.0}
        previous: dict[str, str] = {}
        visited: set[str] = set()
        queue = [(0.0, start)]

        while queue:
            dist, node = heapq.heappop(queue)
            if node in visited:
                continue
            visited.add(node)
            if node == end:
                break
            for edge in graph.adjacency.get(node, []):
                new_dist = dist + edge.weight_seconds
                if new_dist < distances.get(edge.to, float("inf")):
                    distances[edge.to] = new_dist
                    previous[edge.to] = node
                    heapq.heappush(queue, (new_dist, edge.to))

        if end not in distances:
            return {"path": [], "eta_seconds": None, "reachable": False}

        path = [end]
        while path[-1] != start:
            path.append(previous[path[-1]])
        path.reverse()

        return {"path": path, "eta_seconds": round(distances[end], 1), "reachable": True}


emergency_routing_service = EmergencyRoutingService()
