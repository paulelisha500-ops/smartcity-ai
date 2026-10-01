/**
 * Corridor design in the browser.
 *
 * A port of backend/app/services/road_graph.py (A* over the real network) and
 * route_designer.py (the corridor assessment), used by the hosted edition for
 * corridors the API was not asked about in advance. It runs over the API's own
 * routing graph, exported by scripts/export_routing_graph.py — that file's
 * header documents the binary layout read here.
 *
 * Loaded on demand: the graph is a few megabytes and only a custom corridor
 * needs it.
 */
import type { Project, RouteDesign } from "@/lib/api";
import { fetchData, haversineKm, recorded } from "@/lib/static-api";

const SCALE = 100_000;

// Index order is the wire format — it must match ROUTING_CLASSES in road_graph.py.
const ROUTING_CLASSES = [
  "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
  "secondary", "secondary_link", "tertiary", "tertiary_link",
];
// Classes that count as "a road serving this corridor" in the gap analysis.
const STRATEGIC = new Set(
  ["motorway", "trunk", "primary", "secondary", "motorway_link", "trunk_link", "primary_link"]
    .map((name) => ROUTING_CLASSES.indexOf(name)),
);

const TWO_WAY = 0x10;
const CLASS_MASK = 0x0f;

interface Graph {
  nodeCount: number;
  edgeCount: number;
  nodes: Int32Array;        // lat, lon pairs x 1e5
  nodeFlags: Uint8Array;    // bit 0: in the routable core
  from: Uint32Array;
  to: Uint32Array;
  lengthM: Float32Array;
  timeS: Float32Array;
  flags: Uint8Array;
  geomStart: Uint32Array;
  deltas: Int16Array;
  // Outgoing edges per node, as a compressed row list. A two-way edge appears
  // under both its ends; `adjReversed` marks the traversal against storage order.
  adjStart: Uint32Array;
  adjEdge: Uint32Array;
  adjReversed: Uint8Array;
}

let graphPromise: Promise<Graph> | undefined;

function loadGraph(): Promise<Graph> {
  graphPromise ??= fetchData("routing/graph.bin")
    .then((res) => res.arrayBuffer())
    .then(parseGraph);
  graphPromise.catch(() => { graphPromise = undefined; });
  return graphPromise;
}

function parseGraph(buffer: ArrayBuffer): Graph {
  const [nodeCount, edgeCount, deltaCount] = new Uint32Array(buffer, 8, 3);
  const pad = (n: number) => (n + 3) & ~3;
  let offset = 24;
  const take = <T>(make: (at: number) => T, bytes: number): T => {
    const view = make(offset);
    offset += pad(bytes);
    return view;
  };

  const nodes = take((at) => new Int32Array(buffer, at, nodeCount * 2), nodeCount * 8);
  const nodeFlags = take((at) => new Uint8Array(buffer, at, nodeCount), nodeCount);
  const from = take((at) => new Uint32Array(buffer, at, edgeCount), edgeCount * 4);
  const to = take((at) => new Uint32Array(buffer, at, edgeCount), edgeCount * 4);
  const lengthM = take((at) => new Float32Array(buffer, at, edgeCount), edgeCount * 4);
  const timeS = take((at) => new Float32Array(buffer, at, edgeCount), edgeCount * 4);
  const flags = take((at) => new Uint8Array(buffer, at, edgeCount), edgeCount);
  const geomStart = take((at) => new Uint32Array(buffer, at, edgeCount + 1), (edgeCount + 1) * 4);
  const deltas = take((at) => new Int16Array(buffer, at, deltaCount), deltaCount * 2);

  const adjStart = new Uint32Array(nodeCount + 1);
  for (let e = 0; e < edgeCount; e++) {
    adjStart[from[e] + 1]++;
    if (flags[e] & TWO_WAY) adjStart[to[e] + 1]++;
  }
  for (let n = 0; n < nodeCount; n++) adjStart[n + 1] += adjStart[n];
  const cursor = adjStart.slice(0, nodeCount);
  const adjEdge = new Uint32Array(adjStart[nodeCount]);
  const adjReversed = new Uint8Array(adjStart[nodeCount]);
  for (let e = 0; e < edgeCount; e++) {
    adjEdge[cursor[from[e]]++] = e;
    if (flags[e] & TWO_WAY) {
      const slot = cursor[to[e]]++;
      adjEdge[slot] = e;
      adjReversed[slot] = 1;
    }
  }

  return {
    nodeCount, edgeCount, nodes, nodeFlags, from, to, lengthM, timeS, flags,
    geomStart, deltas, adjStart, adjEdge, adjReversed,
  };
}

const nodeLat = (g: Graph, n: number) => g.nodes[2 * n] / SCALE;
const nodeLon = (g: Graph, n: number) => g.nodes[2 * n + 1] / SCALE;

/** An edge's vertices in storage order, both end nodes included. */
function edgeGeometry(g: Graph, e: number): [number, number][] {
  let lat = g.nodes[2 * g.from[e]];
  let lon = g.nodes[2 * g.from[e] + 1];
  const points: [number, number][] = [[lat / SCALE, lon / SCALE]];
  for (let i = g.geomStart[e]; i < g.geomStart[e + 1]; i += 2) {
    lat += g.deltas[i];
    lon += g.deltas[i + 1];
    points.push([lat / SCALE, lon / SCALE]);
  }
  points.push([nodeLat(g, g.to[e]), nodeLon(g, g.to[e])]);
  return points;
}

/**
 * Snap a coordinate onto the network — onto the routable core by default,
 * because the closest node is often a dead-end stub or a one-way sink.
 */
function nearestNode(g: Graph, lat: number, lon: number, routableOnly = true): number {
  let best = -1;
  let bestD = Infinity;
  for (let n = 0; n < g.nodeCount; n++) {
    if (routableOnly && !(g.nodeFlags[n] & 1)) continue;
    const dlat = nodeLat(g, n) - lat;
    const dlon = nodeLon(g, n) - lon;
    if (Math.abs(dlat) > 0.5 || Math.abs(dlon) > 0.5) continue;
    const d = dlat * dlat + dlon * dlon;
    if (d < bestD) [best, bestD] = [n, d];
  }
  return best < 0 && routableOnly ? nearestNode(g, lat, lon, false) : best;
}

/** Binary min-heap of (priority, node). */
class Heap {
  private keys: number[] = [];
  private values: number[] = [];

  get size() { return this.keys.length; }

  push(key: number, value: number) {
    let i = this.keys.length;
    this.keys.push(key);
    this.values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= this.keys[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number {
    const top = this.values[0];
    const lastKey = this.keys.pop() as number;
    const lastValue = this.values.pop() as number;
    if (this.keys.length) {
      this.keys[0] = lastKey;
      this.values[0] = lastValue;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < this.keys.length && this.keys[left] < this.keys[smallest]) smallest = left;
        if (right < this.keys.length && this.keys[right] < this.keys[smallest]) smallest = right;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  private swap(a: number, b: number) {
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
    [this.values[a], this.values[b]] = [this.values[b], this.values[a]];
  }
}

interface RouteResult {
  reachable: boolean;
  error?: string;
  geometry?: [number, number][];
  distance_m?: number;
  eta_seconds?: number;
}

/**
 * A* on travel time. The heuristic divides straight-line distance by the
 * fastest speed on the network (120 km/h), so it never overestimates and the
 * first path popped is optimal.
 */
function astar(g: Graph, start: number, goal: number, maxExpansions = 400_000): RouteResult | null {
  const goalLat = nodeLat(g, goal);
  const goalLon = nodeLon(g, goal);
  const h = (n: number) => (haversineKm(nodeLat(g, n), nodeLon(g, n), goalLat, goalLon) / 120) * 3600;

  const cost = new Float64Array(g.nodeCount).fill(Infinity);
  const cameSlot = new Int32Array(g.nodeCount).fill(-1);
  const camePrev = new Int32Array(g.nodeCount).fill(-1);
  const visited = new Uint8Array(g.nodeCount);
  const heap = new Heap();

  cost[start] = 0;
  heap.push(h(start), start);
  let expansions = 0;

  while (heap.size) {
    const node = heap.pop();
    if (visited[node]) continue;
    visited[node] = 1;
    if (++expansions > maxExpansions) return null;
    if (node === goal) break;

    for (let slot = g.adjStart[node]; slot < g.adjStart[node + 1]; slot++) {
      const e = g.adjEdge[slot];
      const next = g.adjReversed[slot] ? g.from[e] : g.to[e];
      const tentative = cost[node] + g.timeS[e];
      if (tentative < cost[next]) {
        cost[next] = tentative;
        cameSlot[next] = slot;
        camePrev[next] = node;
        heap.push(tentative + h(next), next);
      }
    }
  }
  if (!visited[goal]) return null;

  // Walk back from the goal, then flatten per-edge geometry in travel order.
  const slots: number[] = [];
  for (let cursor = goal; cursor !== start; cursor = camePrev[cursor]) slots.push(cameSlot[cursor]);
  slots.reverse();

  const geometry: [number, number][] = [];
  let distance = 0;
  for (const slot of slots) {
    const e = g.adjEdge[slot];
    const points = edgeGeometry(g, e);
    if (g.adjReversed[slot]) points.reverse();
    distance += g.lengthM[e];
    const last = geometry[geometry.length - 1];
    const joined = last && last[0] === points[0][0] && last[1] === points[0][1];
    geometry.push(...(joined ? points.slice(1) : points));
  }

  return {
    reachable: true,
    geometry,
    distance_m: Math.round(distance * 10) / 10,
    eta_seconds: Math.round(cost[goal] * 10) / 10,
  };
}

function routeBetween(g: Graph, origin: [number, number], destination: [number, number]): RouteResult {
  if (!g.edgeCount) return { reachable: false, error: "road network not ingested yet" };
  const start = nearestNode(g, origin[0], origin[1]);
  const goal = nearestNode(g, destination[0], destination[1]);
  if (start < 0 || goal < 0) {
    return { reachable: false, error: "could not snap coordinates to the road network" };
  }
  return astar(g, start, goal) ?? { reachable: false, error: "no route found between these points" };
}

/* ------------------------------------------------------ corridor assessment */

// A sample further than this from any road is "unserved" — no road corridor.
const UNSERVED_THRESHOLD_M = 1200;
// Detour ratio above which a new connection is worth studying.
const DETOUR_TRIGGER = 1.45;
// How finely the ideal corridor is sampled.
const CORRIDOR_SAMPLES = 40;
// ~5.5 km; anything farther is "unserved" regardless.
const SEARCH_DEG = 0.05;

const UNIT_COST_AED_M_PER_KM: Record<string, number> = {
  at_grade: 30, widening: 45, elevated: 180, bridge: 320, tunnel: 520,
};
const CAPACITY_PER_LANE_VPH = 1800;

const round = (value: number, places: number) => {
  const f = 10 ** places;
  return Math.round(value * f) / f;
};
/** Python prints 40.0 where JavaScript prints 40; the rationale text follows the API. */
const pyFloat = (value: number | null) =>
  value === null ? "None" : Number.isInteger(value) ? value.toFixed(1) : String(value);

let strategicGrid: Map<string, number[]> | undefined;

/** Strategic edges bucketed by SEARCH_DEG cell, so each sample scans its 3x3 block. */
function strategicIndex(g: Graph): Map<string, number[]> {
  if (strategicGrid) return strategicGrid;
  const grid = new Map<string, number[]>();
  for (let e = 0; e < g.edgeCount; e++) {
    if (!STRATEGIC.has(g.flags[e] & CLASS_MASK)) continue;
    let south = 90, west = 180, north = -90, east = -180;
    for (const [lat, lon] of edgeGeometry(g, e)) {
      if (lat < south) south = lat;
      if (lat > north) north = lat;
      if (lon < west) west = lon;
      if (lon > east) east = lon;
    }
    for (let iy = Math.floor(south / SEARCH_DEG); iy <= Math.floor(north / SEARCH_DEG); iy++) {
      for (let ix = Math.floor(west / SEARCH_DEG); ix <= Math.floor(east / SEARCH_DEG); ix++) {
        const key = `${iy}_${ix}`;
        const bucket = grid.get(key);
        if (bucket) bucket.push(e);
        else grid.set(key, [e]);
      }
    }
  }
  strategicGrid = grid;
  return grid;
}

/** Metres to the nearest strategic road within SEARCH_DEG, or null if none. */
function nearestStrategicRoadM(g: Graph, grid: Map<string, number[]>, lat: number, lon: number): number | null {
  const kx = Math.cos((lat * Math.PI) / 180);
  const iy0 = Math.floor(lat / SEARCH_DEG);
  const ix0 = Math.floor(lon / SEARCH_DEG);
  const seen = new Set<number>();
  let best: number | null = null;

  for (let iy = iy0 - 1; iy <= iy0 + 1; iy++) {
    for (let ix = ix0 - 1; ix <= ix0 + 1; ix++) {
      for (const e of grid.get(`${iy}_${ix}`) ?? []) {
        if (seen.has(e)) continue;
        seen.add(e);
        const points = edgeGeometry(g, e);
        for (let i = 0; i + 1 < points.length; i++) {
          const [alat, alon] = points[i];
          const [blat, blon] = points[i + 1];
          // The API filters candidates by planar distance in degrees, then
          // measures the survivor on the sphere; do the same.
          const [flat, flon] = closest(lat, lon, alat, alon, blat, blon, 1);
          if (Math.hypot(flat - lat, flon - lon) > SEARCH_DEG) continue;
          const [clat, clon] = closest(lat, lon, alat, alon, blat, blon, kx);
          const d = haversineKm(lat, lon, clat, clon) * 1000;
          if (best === null || d < best) best = d;
        }
      }
    }
  }
  return best;
}

function closest(
  plat: number, plon: number, alat: number, alon: number, blat: number, blon: number, kx: number,
): [number, number] {
  const dx = (blon - alon) * kx;
  const dy = blat - alat;
  const span = dx * dx + dy * dy;
  const t = span === 0 ? 0 : Math.max(0, Math.min(1, ((plon - alon) * kx * dx + (plat - alat) * dy) / span));
  return [alat + (blat - alat) * t, alon + (blon - alon) * t];
}

function corridorGap(g: Graph, samples: [number, number][], totalKm: number) {
  const grid = strategicIndex(g);
  const farM = SEARCH_DEG * 111_320;
  const distances = samples.map(([lat, lon]) => nearestStrategicRoadM(g, grid, lat, lon) ?? farM);

  // Longest consecutive run of unserved samples is the real physical gap.
  let longestRun = 0;
  let run = 0;
  for (const d of distances) {
    run = d > UNSERVED_THRESHOLD_M ? run + 1 : 0;
    longestRun = Math.max(longestRun, run);
  }
  const unserved = distances.filter((d) => d > UNSERVED_THRESHOLD_M).length;

  return {
    samples: samples.length,
    unserved_samples: unserved,
    unserved_pct: round((unserved / samples.length) * 100, 1),
    max_distance_to_road_m: round(Math.max(...distances), 1),
    mean_distance_to_road_m: round(distances.reduce((a, b) => a + b, 0) / distances.length, 1),
    longest_gap_km: round((totalKm * longestRun) / samples.length, 2),
  };
}

type Conflict = RouteDesign["conflicts"][number];

/** Existing or planned works close enough to the corridor to matter. */
function nearbyProjects(projects: Project[], samples: [number, number][], radiusKm = 6): Conflict[] {
  const out: Conflict[] = [];
  for (const project of projects) {
    if (project.lat === null || project.lon === null) continue;
    const nearest = Math.min(
      ...samples.map(([lat, lon]) => haversineKm(lat, lon, project.lat as number, project.lon as number)),
    );
    if (nearest <= radiusKm) {
      out.push({
        id: project.id, name: project.name, type: project.project_type, status: project.status,
        authority: project.authority, distance_km: round(nearest, 2),
        capacity_vph: project.capacity_vph, source_url: project.source_url,
      });
    }
  }
  return out.sort((a, b) => a.distance_km - b.distance_km);
}

/** 0-100. Rewards time saved, penalises cost and duplicating funded works. */
function feasibilityScore(savingPct: number | null, costAedM: number, conflicts: Conflict[], strategy: string) {
  let score = 50;
  if (savingPct !== null) score += Math.min(30, Math.max(-20, savingPct * 0.6));
  // Cost drag: every AED 500m of capital knocks off ~8 points.
  score -= Math.min(30, (costAedM / 500) * 8);
  for (const c of conflicts) {
    if (c.status === "under_construction" && c.distance_km < 3) score -= 18;
    else if (c.status === "planned" && c.distance_km < 3) score -= 8;
    else if (c.status === "completed" && c.distance_km < 2) score -= 12;
  }
  if (strategy === "widen") score += 8;
  return round(Math.min(100, Math.max(0, score)), 1);
}

function recommendation(score: number, strategy: string, conflicts: Conflict[]): string {
  const blocking = conflicts.find((c) => c.status === "under_construction" && c.distance_km < 3);
  if (blocking) {
    return `Hold — ${blocking.name} is already under construction ` +
           `${pyFloat(blocking.distance_km)} km away. Re-assess once it opens.`;
  }
  const label = strategy.replace(/_/g, " ");
  if (score >= 70) return `Advance to feasibility study — ${label} is well justified.`;
  if (score >= 45) return `Shortlist — ${label} is viable but needs a cost-benefit case.`;
  return "Do not pursue on current evidence — benefits do not justify the capital cost.";
}

export async function designRoute(request: {
  origin: [number, number];
  destination: [number, number];
  originName: string;
  destinationName: string;
  lanes: number;
}): Promise<RouteDesign> {
  const { origin, destination, lanes } = request;
  const [g, projects] = await Promise.all([
    loadGraph(),
    recorded<Project[]>("/api/infrastructure/projects").then((list) => list ?? []),
  ]);

  const straightKm = haversineKm(origin[0], origin[1], destination[0], destination[1]);
  const existing = routeBetween(g, origin, destination);

  const samples: [number, number][] = Array.from({ length: CORRIDOR_SAMPLES }, (_, i) => [
    origin[0] + ((destination[0] - origin[0]) * i) / (CORRIDOR_SAMPLES - 1),
    origin[1] + ((destination[1] - origin[1]) * i) / (CORRIDOR_SAMPLES - 1),
  ]);
  const gap = corridorGap(g, samples, straightKm);
  const conflicts = nearbyProjects(projects, samples);

  let baselineMin: number | null = null;
  let networkKm: number | null = null;
  let detourRatio: number | null = null;
  if (existing.reachable) {
    baselineMin = round((existing.eta_seconds as number) / 60, 1);
    networkKm = round((existing.distance_m as number) / 1000, 2);
    detourRatio = straightKm > 0 ? round(networkKm / straightKm, 2) : null;
  }

  // ---- pick a build strategy from the evidence
  let strategy: string;
  let buildType: string;
  let rationale: string;
  if (!existing.reachable) {
    [strategy, buildType] = ["new_corridor", "at_grade"];
    rationale = "No route exists on the current network between these points.";
  } else if (gap.unserved_pct >= 35 && gap.longest_gap_km >= 1) {
    [strategy, buildType] = ["bridge", "bridge"];
    rationale =
      `${pyFloat(gap.unserved_pct)}% of the direct corridor has no road within ` +
      `${UNSERVED_THRESHOLD_M} m, with an unbroken ${pyFloat(gap.longest_gap_km)} km gap — ` +
      "consistent with a water or undeveloped crossing that a fixed link would close.";
  } else if (detourRatio && detourRatio >= DETOUR_TRIGGER) {
    [strategy, buildType] = ["new_corridor", "elevated"];
    rationale =
      `Drivers travel ${pyFloat(networkKm)} km to cover ${pyFloat(round(straightKm, 2))} km of ` +
      `straight-line distance (detour ratio ${pyFloat(detourRatio)}). A direct link ` +
      "would remove that circuity.";
  } else {
    [strategy, buildType] = ["widen", "widening"];
    rationale =
      `The existing route is reasonably direct (detour ratio ${pyFloat(detourRatio)}). ` +
      "Capacity, not alignment, is the constraint — widening or junction " +
      "upgrades will out-perform a new corridor.";
  }

  const buildKm = strategy !== "widen" ? straightKm : networkKm || straightKm;
  const cost = round(buildKm * (UNIT_COST_AED_M_PER_KM[buildType] ?? UNIT_COST_AED_M_PER_KM.at_grade), 1);

  // New alignment at ~90 km/h design speed; widening keeps the existing path
  // but relieves congestion, modelled as a 25% time improvement.
  const proposedMin = strategy === "widen" && baselineMin
    ? round(baselineMin * 0.75, 1)
    : round((buildKm / 90) * 60, 1);
  const savingPct = baselineMin && baselineMin > 0
    ? round(((baselineMin - proposedMin) / baselineMin) * 100, 1)
    : null;
  const feasibility = feasibilityScore(savingPct, cost, conflicts, strategy);

  return {
    origin: { name: request.originName, lat: origin[0], lon: origin[1] },
    destination: { name: request.destinationName, lat: destination[0], lon: destination[1] },
    straight_line_km: round(straightKm, 2),
    existing_route: {
      reachable: existing.reachable,
      distance_km: networkKm,
      travel_time_min: baselineMin,
      detour_ratio: detourRatio,
      geometry: existing.geometry ?? [],
      error: existing.error ?? null,
    },
    proposed: {
      strategy,
      build_type: buildType,
      geometry: samples,
      length_km: round(buildKm, 2),
      lanes,
      capacity_vph: lanes * CAPACITY_PER_LANE_VPH,
      est_travel_time_min: proposedMin,
      est_cost_aed_m: cost,
      time_saving_pct: savingPct,
    },
    corridor_gap: gap,
    conflicts,
    feasibility_score: feasibility,
    recommendation: recommendation(feasibility, strategy, conflicts),
    rationale,
    method_note:
      "Option-screening estimate. Costs use published UAE unit rates; " +
      "alignment is a straight-line corridor, not a surveyed route.",
  };
}
