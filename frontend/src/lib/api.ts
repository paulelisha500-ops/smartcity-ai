import { getSession, clearSession } from "@/lib/auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8001";

/**
 * Thrown specifically for 401/403 so callers (and the global fetch error
 * boundary) can tell "you're not allowed to do this" apart from "the network
 * is down" — those need different UI: a sign-in prompt vs. a retry banner.
 */
export class ApiAuthError extends Error {
  status: number;
  constructor(path: string, status: number) {
    super(`API ${path} failed: ${status}`);
    this.status = status;
  }
}

/** Non-auth HTTP failure, carrying the server's own explanation when it gave one. */
export class ApiError extends Error {
  status: number;
  detail: string | null;
  constructor(path: string, status: number, detail: string | null) {
    super(detail ?? `API ${path} failed: ${status}`);
    this.status = status;
    this.detail = detail;
  }
}

/** Raised when a request exceeds its time budget, or the network is unreachable. */
export class ApiNetworkError extends Error {
  timedOut: boolean;
  constructor(path: string, timedOut: boolean) {
    super(timedOut ? `${path} timed out` : `Can't reach the API`);
    this.timedOut = timedOut;
  }
}

/** Pull FastAPI's `detail` (string, or a list of validation errors) into one sentence. */
async function readDetail(res: Response): Promise<string | null> {
  try {
    const body = await res.json();
    const d = body?.detail;
    if (typeof d === "string") return d;
    if (Array.isArray(d) && d.length) {
      // 422s: [{loc:["body","text"], msg:"String should have at least 5 characters"}]
      const first = d[0];
      const field = Array.isArray(first?.loc) ? first.loc.slice(1).join(".") : "";
      const msg = String(first?.msg ?? "invalid input").replace(/^Value error, /, "");
      return field ? `${field}: ${msg}` : msg;
    }
  } catch {
    /* body wasn't JSON */
  }
  return null;
}

/**
 * Turn anything thrown by `request()` into text a user can act on. Use this in
 * catch blocks instead of a hard-coded "can't reach the backend" — that message
 * was being shown for validation failures and permission errors too.
 */
export function describeError(e: unknown, fallback = "Something went wrong."): string {
  if (e instanceof ApiAuthError) {
    return e.status === 403
      ? "Your role doesn't have permission for this."
      : "Your session has expired — sign in again.";
  }
  if (e instanceof ApiNetworkError) {
    return e.timedOut
      ? "The request took too long. Check your connection and try again."
      : "Can't reach the server. Check your connection and try again.";
  }
  if (e instanceof ApiError) return e.detail ?? `The server rejected the request (HTTP ${e.status}).`;
  return fallback;
}

// Default budget. Long-running analyses pass their own.
const DEFAULT_TIMEOUT_MS = 30_000;

async function request<T>(path: string, options?: RequestInit & { timeoutMs?: number }): Promise<T> {
  // Most reads (traffic, infrastructure, places, digital-twin) are public and
  // work with no token at all — see the auth comments on each backend router
  // for what's actually gated. When a session exists we still send it, since
  // some endpoints (complaint list, camera fleet, ingestion) require it.
  const session = getSession();
  // The session is an httpOnly cookie (sent via credentials: "include").
  // X-Requested-With is the CSRF guard: the API requires a custom header on
  // cookie-authenticated writes, which a cross-site form can't add.
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Requested-With": "smartcity-console",
  };

  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...init } = options ?? {};

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      credentials: "include",
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
      // Without a timeout a stalled connection leaves the UI on "loading…"
      // forever, and the caller's `finally` never runs.
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timedOut = e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
    throw new ApiNetworkError(path, timedOut);
  }

  if (res.status === 401 || res.status === 403) {
    // A 401 with a session on file means the cookie expired or was rejected —
    // drop it so the next navigation re-prompts login instead of silently
    // retrying the same dead token forever. A 403 means the role just isn't
    // permitted; the session itself is still valid, so it's kept.
    if (res.status === 401 && session) {
      clearSession();
      // AppShell listens for this to bounce to /login immediately.
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("smartcity:auth-expired"));
      }
    }
    throw new ApiAuthError(path, res.status);
  }
  if (!res.ok) {
    throw new ApiError(path, res.status, await readDetail(res));
  }
  return res.json();
}

/* ---------------------------------------------------------------- M1 / M4 */
export interface TrafficReading {
  intersection_id: number;
  intersection_name: string;
  lat: number;
  lon: number;
  ts: string;
  vehicle_count: number;
  avg_speed_kmh: number;
  congestion_score: number;
  queue_length_m: number;
  lane_occupancy_pct: number;
}

export interface Hotspot {
  rank: number;
  intersection_id: number;
  intersection_name: string;
  lat: number;
  lon: number;
  congestion_score: number;
}

/* --------------------------------------------------------------------- M2 */
export interface RoadDamagePoint {
  id: number;
  name: string;
  lat: number;
  lon: number;
  damage_type: string;
  severity: number;
  confidence: number;
  ts: string;
}

/* --------------------------------------------------------------------- M3 */
export interface Complaint {
  id: number;
  ts: string;
  text: string;
  category: string | null;
  sentiment: string | null;
  priority: string | null;
  department: string | null;
  status: string;
  lat: number | null;
  lon: number | null;
}

/* --------------------------------------------------------------------- M8 */
export interface KPIs {
  congestion_index: number;
  avg_speed_kmh: number;
  road_quality_score: number;
  complaint_count: number;
  complaint_resolution_rate_pct: number;
  public_satisfaction_proxy_pct: number;
}

export interface CongestionHistoryPoint {
  hour: string;
  avg_congestion_score: number;
  avg_speed_kmh: number;
  samples: number;
}

export interface ComplaintHistoryPoint {
  day: string;
  total: number;
  high_priority: number;
  resolved: number;
}

/* --------------------------------------------------------------------- M9 */
export interface CameraRow {
  id: number;
  name: string;
  lat: number | null;
  lon: number | null;
  emirate: string | null;
  road_ref: string | null;
  protocol: string;
  host: string;
  port: number | null;
  stream_path: string | null;
  has_substream: boolean;
  owner_org: string | null;
  authorized: boolean;
  authorization_ref: string | null;
  status: string;
  last_seen: string | null;
  last_error: string | null;
  latency_ms: number | null;
  resolution: string | null;
  codec: string | null;
  manufacturer: string | null;
  model: string | null;
  firmware: string | null;
  enabled: boolean;
  credential_configured: boolean;
}

export interface CameraSummary {
  total: number;
  authorized: number;
  online: number;
  availability_pct: number;
  by_status: Record<string, number>;
  by_emirate: Record<string, number>;
  avg_latency_ms: number | null;
}

export interface CameraTestResult {
  camera_id: number;
  ok: boolean;
  status: string;
  latency_ms: number | null;
  codec: string | null;
  resolution: string | null;
  error: string | null;
  analytics_stream: string;
}

/* -------------------------------------------------------------------- M10 */
export interface RoadLinkGeo {
  id: number;
  name: string | null;
  ref: string | null;
  highway: string;
  lanes: number | null;
  maxspeed_kmh: number | null;
  length_m: number;
  bridge: boolean;
  tunnel: boolean;
  toll: boolean;
  emirate: string | null;
  is_international: boolean;
  congestion_score: number;
  geometry: [number, number][];
}

export interface BorderCrossingRow {
  id: number;
  name: string;
  lat: number;
  lon: number;
  country_a: string;
  country_b: string;
  emirate: string | null;
  road_ref: string | null;
  open_24h: boolean;
  freight_enabled: boolean;
  notes: string | null;
  source: string | null;
}

export interface NetworkStatus {
  ingested: boolean;
  road_links: number;
  network_km: number;
  border_crossings: number;
  international_links: number;
  by_class: Record<string, number>;
  by_emirate: Record<string, number>;
  source: string;
}

/* -------------------------------------------------------------------- M11 */
export interface Project {
  id: number;
  name: string;
  project_type: string;
  status: string;
  authority: string | null;
  emirate: string | null;
  lat: number | null;
  lon: number | null;
  length_m: number | null;
  lanes: number | null;
  capacity_vph: number | null;
  cost_aed_m: number | null;
  travel_time_saving_pct: number | null;
  completion_year: number | null;
  opened_on: string | null;
  description: string | null;
  source_url: string | null;
}

export interface ProjectSummary {
  total_projects: number;
  by_status: Record<string, number>;
  by_type: Record<string, number>;
  by_emirate: Record<string, number>;
  capacity_added_vph: number;
  known_cost_aed_m: number;
  avg_travel_time_saving_pct: number | null;
}

/* ------------------------------------------------ places / geocoding (M10) */
export interface PlaceResult {
  type: "place" | "street";
  id: number | null;
  name: string;
  name_ar?: string | null;
  ref?: string | null;
  category: string;
  subcategory?: string | null;
  emirate: string | null;
  lat: number;
  lon: number;
  population?: number | null;
  length_km?: number;
  distance_km?: number;
  score: number;
}

export interface PlacesStatus {
  loaded: boolean;
  total_places: number;
  by_emirate: Record<string, number>;
  by_category: Record<string, number>;
  emirates_available: string[];
}

export interface NamedStreet {
  name: string;
  ref: string | null;
  emirate: string | null;
  segments: number;
  length_km: number;
}

/* -------------------------------------------------------------------- M12 */
export interface RouteDesign {
  origin: { name: string; lat: number; lon: number };
  destination: { name: string; lat: number; lon: number };
  straight_line_km: number;
  existing_route: {
    reachable: boolean;
    distance_km: number | null;
    travel_time_min: number | null;
    detour_ratio: number | null;
    geometry: [number, number][];
    error?: string | null;
  };
  proposed: {
    strategy: string;
    build_type: string;
    geometry: [number, number][];
    length_km: number;
    lanes: number;
    capacity_vph: number;
    est_travel_time_min: number;
    est_cost_aed_m: number;
    time_saving_pct: number | null;
  };
  corridor_gap: Record<string, number | string>;
  conflicts: {
    id: number;
    name: string;
    type: string;
    status: string;
    authority: string | null;
    distance_km: number;
    capacity_vph: number | null;
    source_url: string | null;
  }[];
  feasibility_score: number;
  recommendation: string;
  rationale: string;
  method_note: string;
}

export interface DesignPreset {
  id: string;
  name: string;
  origin_name: string;
  origin_lat: number;
  origin_lon: number;
  destination_name: string;
  dest_lat: number;
  dest_lon: number;
  why: string;
}

/* --------------------------------------------------------------------- M7 */
export interface Facility {
  id: string;
  name: string;
  type: string;
  lat: number;
  lon: number;
  emirate: string;
  rank?: number;
  straight_line_km?: number;
  eta_minutes?: number;
  distance_km?: number;
  geometry?: [number, number][];
}

export interface GeoRoute {
  reachable: boolean;
  network: string;
  geometry?: [number, number][];
  distance_m?: number;
  distance_km?: number;
  eta_seconds?: number;
  eta_minutes?: number;
  civilian_eta_seconds?: number;
  toll_segments?: number;
  steps?: { road: string; ref: string | null; distance_m: number; time_s: number; toll: boolean }[];
  error?: string;
}

export const api = {
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  /* M1 / M4 */
  liveTraffic: () => request<TrafficReading[]>("/api/traffic/live"),
  hotspots: (limit = 5) => request<Hotspot[]>(`/api/traffic/hotspots?limit=${limit}`),
  forecast: (intersectionId: number, horizonHours = 24) =>
    request(`/api/prediction/intersection/${intersectionId}?horizon_hours=${horizonHours}`),

  /* M2 */
  roadDamagePriority: (limit = 10) =>
    request<RoadDamagePoint[]>(`/api/road-damage/priority?limit=${limit}`),

  /* M3 */
  complaints: () => request<Complaint[]>("/api/complaints"),
  submitComplaint: (payload: { text: string; lat?: number; lon?: number }) =>
    request<Complaint>("/api/complaints", { method: "POST", body: JSON.stringify(payload) }),

  /* M5 */
  askPlanner: (question: string) =>
    request<{ answer: string; sources_used: string[] }>("/api/planner/ask", {
      method: "POST",
      body: JSON.stringify({ question }),
    }),

  /* M6 / M8 */
  digitalTwinLayers: () =>
    request<{ traffic: TrafficReading[]; road_damage: RoadDamagePoint[]; complaints: any[] }>(
      "/api/digital-twin/layers"
    ),
  kpis: () => request<KPIs>("/api/analytics/kpis"),
  congestionHistory: (hours = 24, intersectionId?: number) =>
    request<CongestionHistoryPoint[]>(
      `/api/analytics/history/congestion?hours=${hours}${intersectionId ? `&intersection_id=${intersectionId}` : ""}`
    ),
  complaintHistory: (days = 30) =>
    request<ComplaintHistoryPoint[]>(`/api/analytics/history/complaints?days=${days}`),

  /* M7 — emergency dispatch */
  facilities: (type?: string) =>
    request<Facility[]>(`/api/emergency/facilities${type ? `?facility_type=${type}` : ""}`),
  nearestFacility: (lat: number, lon: number, type = "hospital") =>
    request<{ candidates: Facility[]; recommended: Facility | null; routed_on_real_network: boolean }>(
      `/api/emergency/nearest-facility?lat=${lat}&lon=${lon}&facility_type=${type}`
    ),
  routeGeo: (payload: {
    origin_lat: number; origin_lon: number; dest_lat: number; dest_lon: number;
    vehicle_type?: string; emergency?: boolean; avoid_tolls?: boolean;
  }) => request<GeoRoute>("/api/emergency/route-geo", {
    method: "POST", body: JSON.stringify(payload),
  }),

  /* M9 — cameras */
  cameras: (emirate?: string) =>
    request<CameraRow[]>(`/api/cameras${emirate ? `?emirate=${emirate}` : ""}`),
  cameraSummary: () => request<CameraSummary>("/api/cameras/summary"),
  testCamera: (id: number) =>
    request<CameraTestResult>(`/api/cameras/${id}/test`, { method: "POST" }),
  healthSweep: () =>
    request<{ checked: number; skipped_unauthorized: number; online: number }>(
      "/api/cameras/health-sweep", { method: "POST", timeoutMs: 180_000 }
    ),
  seedCameraSites: () =>
    request<{ sites_created: number; total: number }>("/api/cameras/seed-sites", { method: "POST" }),
  integrationGuide: () => request<any>("/api/cameras/integration-guide"),
  registerCamera: (payload: Record<string, unknown>) =>
    request<CameraRow>("/api/cameras", { method: "POST", body: JSON.stringify(payload) }),

  /* M10 — network */
  networkStatus: () => request<NetworkStatus>("/api/network/status"),
  ingestNetwork: (wait = false) =>
    request<any>(`/api/network/ingest?wait=${wait}`, { method: "POST", timeoutMs: 600_000 }),
  roads: (params: { bbox?: string; highway?: string; limit?: number; international_only?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (params.bbox) q.set("bbox", params.bbox);
    if (params.highway) q.set("highway", params.highway);
    if (params.limit) q.set("limit", String(params.limit));
    if (params.international_only) q.set("international_only", "true");
    return request<RoadLinkGeo[]>(`/api/network/roads?${q.toString()}`);
  },
  borderCrossings: () => request<BorderCrossingRow[]>("/api/network/border-crossings"),
  corridors: () =>
    request<{ corridors: Record<string, any[]>; countries: string[]; total_crossings: number }>(
      "/api/network/corridors"
    ),
  namedStreets: (emirate?: string, limit = 200) =>
    request<NamedStreet[]>(
      `/api/network/streets?limit=${limit}${emirate ? `&emirate=${encodeURIComponent(emirate)}` : ""}`
    ),
  ingestStreets: (emirate: string) =>
    request<any>(`/api/network/ingest-streets?emirate=${encodeURIComponent(emirate)}`, {
      method: "POST",
    }),

  /* Gazetteer & geocoding */
  placesStatus: () => request<PlacesStatus>("/api/places/status"),
  searchPlaces: (q: string, opts: { emirate?: string; limit?: number; category?: string } = {}) => {
    const p = new URLSearchParams({ q, limit: String(opts.limit ?? 12) });
    if (opts.emirate) p.set("emirate", opts.emirate);
    if (opts.category) p.set("category", opts.category);
    return request<PlaceResult[]>(`/api/places/search?${p.toString()}`);
  },
  reverseGeocode: (lat: number, lon: number) =>
    request<any>(`/api/places/reverse?lat=${lat}&lon=${lon}`),
  places: (opts: { emirate?: string; category?: string; limit?: number } = {}) => {
    const p = new URLSearchParams({ limit: String(opts.limit ?? 500) });
    if (opts.emirate) p.set("emirate", opts.emirate);
    if (opts.category) p.set("category", opts.category);
    return request<any[]>(`/api/places?${p.toString()}`);
  },
  ingestPlaces: (emirate?: string) =>
    request<any>(`/api/places/ingest${emirate ? `?emirate=${encodeURIComponent(emirate)}` : ""}`, {
      method: "POST",
    }),

  /* M11 — infrastructure */
  projects: (status?: string) =>
    request<Project[]>(`/api/infrastructure/projects${status ? `?status=${status}` : ""}`),
  bridges: () => request<Project[]>("/api/infrastructure/bridges"),
  projectSummary: () => request<ProjectSummary>("/api/infrastructure/summary"),
  seedProjects: () =>
    request<{ projects_inserted: number; total_in_register: number }>(
      "/api/infrastructure/seed", { method: "POST" }
    ),

  /* M12 — route design */
  designPresets: () => request<DesignPreset[]>("/api/route-design/presets"),
  analyzeRoute: (payload: {
    origin_lat: number; origin_lon: number; dest_lat: number; dest_lon: number;
    origin_name?: string; destination_name?: string; lanes?: number; save?: boolean;
  }) => request<RouteDesign>("/api/route-design/analyze", {
    method: "POST", body: JSON.stringify(payload), timeoutMs: 120_000,
  }),
  proposals: () => request<any[]>("/api/route-design/proposals"),
};
