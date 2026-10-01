/**
 * Static data layer.
 *
 * The hosted edition is a static site: there is no API server behind it. When
 * NEXT_PUBLIC_STATIC_API=1, lib/api.ts hands every request to `staticFetch`
 * instead of the network, and it is answered from the snapshot in /data
 * (written by scripts/snapshot_static.py). The answer is shaped like a fetch
 * `Response`, so the status handling in lib/api.ts runs unchanged.
 *
 * Three kinds of answer:
 *  - recorded — read endpoints replay the API's own output;
 *  - computed — the traffic model, search, reverse geocoding, complaint
 *    analysis, the planner and corridor design are ports of the backend
 *    services, run in the browser over the same data;
 *  - fixed    — console actions whose outcome the published data set already
 *    determines (seeding, probing placeholder camera sites) replay what the
 *    server returns for them.
 */
import type {
  Complaint, CongestionHistoryPoint, DesignPreset, Hotspot, KPIs, RoadDamagePoint, RoadLinkGeo,
  TrafficReading,
} from "@/lib/api";
import type { LiveEvent } from "@/lib/live";

const DATA = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/data`;

/* ------------------------------------------------------------ plumbing */

const cache = new Map<string, Promise<unknown>>();

/**
 * Fetch one file of the data set. Every file is stored gzip-compressed
 * (`name.gz`): the static host sends bytes as they are, with no transfer
 * compression, and JSON geometry shrinks about fivefold. If a server does
 * apply `Content-Encoding` the bytes arrive already inflated, so the gzip
 * magic number decides rather than the file name.
 */
export async function fetchData(file: string): Promise<Response> {
  const res = await fetch(`${DATA}/${file}.gz`);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const bytes = await res.arrayBuffer();
  const head = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
  if (head[0] !== 0x1f || head[1] !== 0x8b) return new Response(bytes);
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")));
}

/** One fetch per file for the life of the page; a failed fetch is retried. */
export function load<T>(file: string): Promise<T> {
  let hit = cache.get(file) as Promise<T> | undefined;
  if (!hit) {
    hit = fetchData(file).then((res) => res.json() as Promise<T>);
    hit.catch(() => cache.delete(file));
    cache.set(file, hit);
  }
  return hit;
}

/**
 * The slice of `Response` that callers read. Handing the parsed body straight
 * back avoids serialising and re-parsing a few megabytes of road geometry.
 */
function reply(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function canonical(route: string, q: URLSearchParams): string {
  const pairs = Array.from(q.entries(), ([k, v]) => `${k}=${v}`).sort();
  return pairs.length ? `${route}?${pairs.join("&")}` : route;
}

export async function recorded<T>(key: string): Promise<T | undefined> {
  const file = (await load<Record<string, string>>("manifest.json"))[key];
  return file ? load<T>(file) : undefined;
}

/** What the console's first screen reads; fetched ahead of sign-in. */
const FIRST_SCREEN = [
  "/api/traffic/intersections", "/api/digital-twin/layers", "/api/analytics/kpis", "/api/complaints",
  "/api/network/status", "/api/network/roads?highway=motorway,trunk&limit=500",
  "/api/network/border-crossings", "/api/cameras", "/api/infrastructure/projects",
  "/api/places?category=place&limit=400", "/api/places/status",
];

export function warm(): void {
  for (const key of FIRST_SCREEN) recorded(key).catch(() => {});
}

const round = (value: number, places: number) => {
  const f = 10 ** places;
  return Math.round(value * f) / f;
};

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dp = (lat2 - lat1) * rad;
  const dl = (lon2 - lon1) * rad;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dl / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(a));
}

/* ---------------------------------------------------------------- auth */

const ACCOUNTS: Record<string, string> = {
  "admin@city.gov": "admin",
  "officer@city.gov": "traffic_officer",
  "planner@city.gov": "city_planner",
  "maintenance@city.gov": "maintenance_department",
  "citizen@example.com": "public_user",
};
const ACCOUNT_PASSWORD = process.env.NEXT_PUBLIC_ACCOUNT_PASSWORD ?? "";
const SESSION_HOURS = 8;

/** Mirrors POST /api/auth/login for the built-in role accounts. */
export function staticLogin(email: string, password: string): Response {
  if (!/^\S+@\S+\.\S+$/.test(email) || !password) {
    return reply({ detail: "Enter a valid email address and a password." }, 422);
  }
  const role = ACCOUNTS[email.trim().toLowerCase()];
  if (!role || !ACCOUNT_PASSWORD || password !== ACCOUNT_PASSWORD) {
    return reply({ detail: "Invalid credentials" }, 401);
  }
  return reply({ email, role, expires_at: Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600 });
}

/* ----------------------------------------------------------- live feed */

type Listener = (event: LiveEvent) => void;
const listeners = new Set<Listener>();
let ticker: ReturnType<typeof setInterval> | undefined;

function emit(event: LiveEvent) {
  listeners.forEach((listener) => listener(event));
}

/**
 * The live feed. As on the server when no CV pipeline is attached, congestion
 * ticks are modelled: one monitored junction every five seconds. Complaints
 * filed in this session are published to it as they are on the server.
 */
export function subscribeLive(listener: Listener): () => void {
  listeners.add(listener);
  if (!ticker) {
    ticker = setInterval(async () => {
      const spots = await intersections().catch(() => undefined);
      if (!spots?.length) return;
      const spot = spots[Math.floor(Math.random() * spots.length)];
      emit({
        type: "congestion_update",
        intersection_id: spot.id,
        intersection_name: spot.name,
        congestion_score: round(20 + Math.random() * 75, 1),
      });
    }, 5000);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearInterval(ticker);
      ticker = undefined;
    }
  };
}

/* --------------------------------------- traffic model (port of traffic_cv) */

interface Intersection { id: number; name: string; lat: number; lon: number }
type Reading = Pick<TrafficReading,
  "vehicle_count" | "avg_speed_kmh" | "congestion_score" | "queue_length_m" | "lane_occupancy_pct">;

const RUSH_HOURS = new Set([7, 8, 9, 17, 18, 19]);
const HOUR_MS = 3_600_000;
const QUARTER_MS = HOUR_MS / 4;

async function intersections(): Promise<Intersection[]> {
  return (await recorded<Intersection[]>("/api/traffic/intersections")) ?? [];
}

/** `_seeded_value`: the SHA-256 of the key, mapped onto [low, high). */
async function seeded(key: string, low: number, high: number): Promise<number> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return low + (Number(BigInt(`0x${hex}`) % BigInt(10_000)) / 10_000) * (high - low);
}

/** Readings are a function of (junction, UTC hour), so each is worked out once. */
const readingCache = new Map<string, Promise<Reading>>();

function analyseIntersection(spot: Intersection, ts: Date): Promise<Reading> {
  const stamp = ts.toISOString();
  const key = `${spot.id}-${spot.name}-${stamp.slice(0, 10)}-${stamp.slice(11, 13)}`;
  let hit = readingCache.get(key);
  if (!hit) {
    hit = (async () => {
      const rush = RUSH_HOURS.has(ts.getUTCHours()) ? 1.6 : 1;
      const [count, speed, queue, occupancy] = await Promise.all([
        seeded(`${key}count`, 40, 220), seeded(`${key}speed`, 15, 55),
        seeded(`${key}queue`, 5, 120), seeded(`${key}occ`, 20, 70),
      ]);
      const vehicles = Math.trunc(count * rush);
      const avgSpeed = Math.max(5, speed / rush);
      const queueLength = queue * rush;
      // High vehicle count + low speed + long queue -> high score.
      const congestion = Math.min(
        100,
        (vehicles / 250) * 40 + ((60 - Math.min(avgSpeed, 60)) / 60) * 40 + (Math.min(queueLength, 150) / 150) * 20,
      );
      return {
        vehicle_count: vehicles,
        avg_speed_kmh: round(avgSpeed, 1),
        congestion_score: round(congestion, 1),
        queue_length_m: round(queueLength, 1),
        lane_occupancy_pct: round(Math.min(100, occupancy * rush), 1),
      };
    })();
    readingCache.set(key, hit);
  }
  return hit;
}

async function liveTraffic(): Promise<TrafficReading[]> {
  const now = new Date();
  const ts = now.toISOString().replace("Z", "");
  return Promise.all((await intersections()).map(async (spot) => ({
    intersection_id: spot.id, intersection_name: spot.name, lat: spot.lat, lon: spot.lon, ts,
    ...(await analyseIntersection(spot, now)),
  })));
}

async function hotspots(limit: number): Promise<Hotspot[]> {
  return (await liveTraffic())
    .sort((a, b) => b.congestion_score - a.congestion_score)
    .slice(0, limit)
    .map((r, i) => ({
      rank: i + 1, intersection_id: r.intersection_id, intersection_name: r.intersection_name,
      lat: r.lat, lon: r.lon, congestion_score: r.congestion_score,
    }));
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

/**
 * Hourly congestion and speed trend. The server charts the readings its
 * scheduler stores every 15 minutes; a stored reading is the model's value
 * for that hour, so the same series is rebuilt here from the model.
 */
async function congestionHistory(q: URLSearchParams): Promise<CongestionHistoryPoint[]> {
  const hours = Math.max(1, Math.min(Number(q.get("hours") ?? 24), 24 * 30));
  const only = q.get("intersection_id");
  const spots = (await intersections()).filter((s) => !only || s.id === Number(only));
  if (!spots.length) return [];

  const now = Date.now();
  const since = now - hours * HOUR_MS;
  const out: CongestionHistoryPoint[] = [];
  for (let hour = Math.floor(since / HOUR_MS) * HOUR_MS; hour <= now; hour += HOUR_MS) {
    // Snapshots fall on the quarter hours; count those inside the window.
    const first = Math.ceil(Math.max(hour, since) / QUARTER_MS);
    const last = Math.floor(Math.min(hour + HOUR_MS - 1, now) / QUARTER_MS);
    if (last < first) continue;
    const readings = await Promise.all(spots.map((spot) => analyseIntersection(spot, new Date(hour))));
    out.push({
      hour: new Date(hour).toISOString().slice(0, 19),
      avg_congestion_score: round(mean(readings.map((r) => r.congestion_score)), 1),
      avg_speed_kmh: round(mean(readings.map((r) => r.avg_speed_kmh)), 1),
      samples: (last - first + 1) * spots.length,
    });
  }
  return out;
}

/** The KPI set, recomputed from live traffic and the current complaint list. */
async function kpis(): Promise<KPIs> {
  const [base, traffic, complaints] = await Promise.all([
    recorded<KPIs>("/api/analytics/kpis"), liveTraffic(), listComplaints(),
  ]);
  const negative = complaints.filter((c) => c.sentiment === "negative").length;
  const resolved = complaints.filter((c) => c.status === "resolved").length;
  return {
    congestion_index: traffic.length ? round(mean(traffic.map((t) => t.congestion_score)), 1) : 0,
    avg_speed_kmh: traffic.length ? round(mean(traffic.map((t) => t.avg_speed_kmh)), 1) : 0,
    road_quality_score: base?.road_quality_score ?? 100,
    complaint_count: complaints.length,
    complaint_resolution_rate_pct: complaints.length ? round((resolved / complaints.length) * 100, 1) : 0,
    public_satisfaction_proxy_pct: complaints.length ? round(100 - (negative / complaints.length) * 100, 1) : 100,
  };
}

interface TwinLayers {
  traffic: TrafficReading[];
  road_damage: RoadDamagePoint[];
  complaints: { id: number; lat: number; lon: number; category: string | null; priority: string | null; status: string }[];
}

async function digitalTwinLayers(): Promise<TwinLayers> {
  const [base, traffic] = await Promise.all([
    recorded<TwinLayers>("/api/digital-twin/layers"), liveTraffic(),
  ]);
  const filed = submitted
    .filter((c) => c.lat !== null && c.lon !== null)
    .map((c) => ({
      id: c.id, lat: c.lat as number, lon: c.lon as number,
      category: c.category, priority: c.priority, status: c.status,
    }));
  return {
    traffic,
    road_damage: base?.road_damage ?? [],
    complaints: [...filed, ...(base?.complaints ?? [])],
  };
}

/* ---------------------------------------- complaints (port of complaint_nlp) */

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  pothole: ["pothole", "pot hole", "hole in the road", "crater", "sunken road", "broken pavement"],
  traffic_signal: ["signal", "traffic light", "stoplight", "red light not working", "signal broken"],
  flooding: ["waterlogging", "flood", "water logged", "drain", "sewage", "standing water"],
  signage: ["sign missing", "no sign", "road sign", "missing signage", "stop sign"],
  streetlight: ["street light", "streetlight", "lamp post", "dark road", "no light"],
  congestion: ["traffic jam", "congestion", "bumper to bumper", "gridlock", "stuck in traffic"],
  accident_risk: ["accident", "near miss", "collision", "dangerous crossing", "unsafe intersection"],
};
const DEPARTMENT_ROUTING: Record<string, string> = {
  pothole: "roads_maintenance",
  traffic_signal: "traffic_signals",
  flooding: "drainage",
  signage: "roads_maintenance",
  streetlight: "public_works_electrical",
  congestion: "traffic_management",
  accident_risk: "traffic_police",
  other: "general_admin",
};
const NEGATIVE_WORDS = new Set([
  "broken", "huge", "dangerous", "unsafe", "terrible", "awful", "worse", "worst",
  "flooded", "blocked", "ignored", "weeks", "months", "again", "still", "never",
  "urgent", "emergency", "injured", "accident", "crash", "angry", "frustrated",
]);
const POSITIVE_WORDS = new Set(["thank", "thanks", "great", "fixed", "quick", "appreciate", "resolved"]);
const NEGATION_WORDS = new Set(["not", "no", "never", "n't"]);
const SAFETY_KEYWORDS = [
  "accident", "injured", "collision", "crash", "child", "school", "hospital", "ambulance", "blind spot",
];
const LANDMARKS: [string, number, number][] = [
  ["hospital", 25.4052, 55.4033],
  ["school", 25.4111, 55.4372],
  ["main market", 25.3995, 55.418],
  ["central mall", 25.4123, 55.431],
  ["bus station", 25.3978, 55.426],
  ["corniche", 25.418, 55.445],
];
const PRIORITY_BASE: Record<string, number> = {
  accident_risk: 0.8, traffic_signal: 0.55, flooding: 0.6, pothole: 0.45,
  streetlight: 0.4, signage: 0.35, congestion: 0.3, other: 0.2,
};

function analyseComplaint(text: string) {
  const lower = text.toLowerCase();

  let category = "other";
  let best = 0;
  for (const [name, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    const score = keywords.filter((kw) => lower.includes(kw)).length;
    if (score > best) {
      category = name;
      best = score;
    }
  }

  const tokens = lower.match(/[a-z']+/g) ?? [];
  let pos = tokens.filter((t) => POSITIVE_WORDS.has(t)).length;
  let neg = tokens.filter((t) => NEGATIVE_WORDS.has(t)).length;
  // "not fixed" should read negative even though "fixed" is a positive word.
  tokens.forEach((t, i) => {
    if (NEGATION_WORDS.has(t) && POSITIVE_WORDS.has(tokens[i + 1])) {
      pos -= 1;
      neg += 1;
    }
  });
  let sentiment = "neutral";
  let sentimentScore = 0;
  if (pos !== 0 || neg !== 0) {
    sentimentScore = Math.max(-1, Math.min(1, (pos - neg) / Math.max(1, pos + neg)));
    if (sentimentScore > 0.15) sentiment = "positive";
    else if (sentimentScore < -0.15) sentiment = "negative";
  }

  const near = /\bnear\s+(the\s+)?([a-zA-Z ]{3,40}?)(?:[.,!]|$)/i.exec(text);
  let locationText: string | null = near ? near[2].trim() : null;
  let lat: number | null = null;
  let lon: number | null = null;
  const landmark = LANDMARKS.find(([name]) => lower.includes(name));
  if (landmark) [locationText, lat, lon] = landmark;

  const safety = SAFETY_KEYWORDS.some((kw) => lower.includes(kw)) ? 0.25 : 0;
  const urgency = ["weeks", "months", "still", "again"].some((w) => lower.includes(w)) ? 0.15 : 0;
  const priorityScore = Math.min(
    1, (PRIORITY_BASE[category] ?? 0.2) + safety + urgency + Math.max(0, -sentimentScore) * 0.15,
  );
  const priority =
    priorityScore >= 0.75 ? "critical" : priorityScore >= 0.55 ? "high" : priorityScore >= 0.35 ? "medium" : "low";

  return {
    category, sentiment, sentiment_score: round(sentimentScore, 2),
    priority, priority_score: round(priorityScore, 2),
    department: DEPARTMENT_ROUTING[category], raw_location_text: locationText, lat, lon,
  };
}

/** Reports filed during this visit; they sit on top of the recorded list. */
const submitted: Complaint[] = [];

async function listComplaints(): Promise<Complaint[]> {
  return [...submitted, ...((await recorded<Complaint[]>("/api/complaints")) ?? [])];
}

async function submitComplaint(body: { text?: string; lat?: number; lon?: number }): Promise<Response> {
  const text = (body.text ?? "").trim();
  if (text.length < 5) {
    return reply({ detail: [{ loc: ["body", "text"], msg: "String should have at least 5 characters" }] }, 422);
  }
  const analysis = analyseComplaint(text);
  const existing = await listComplaints();
  const complaint = {
    ...analysis,
    id: existing.reduce((max, c) => Math.max(max, c.id), 0) + 1,
    // The API reports naive UTC timestamps; match the format so the list sorts
    // and renders the same.
    ts: new Date().toISOString().replace("Z", ""),
    text,
    status: "routed",
    lat: body.lat ?? analysis.lat,
    lon: body.lon ?? analysis.lon,
  } as Complaint;
  submitted.unshift(complaint);
  emit({
    type: "new_complaint", id: complaint.id, category: complaint.category,
    priority: complaint.priority, department: complaint.department,
    lat: complaint.lat, lon: complaint.lon, ts: complaint.ts,
  });
  return reply(complaint);
}

/* ------------------------------------------- planner (port of rag_planner) */

const CONGESTION_TAGS = [
  "congestion", "congested", "traffic", "hotspot", "intersection", "widen", "busy", "busiest", "junction", "jam",
];
const MAINTENANCE_TAGS = ["maintenance", "maintain", "road", "damage", "pothole", "repair", "condition", "crack"];

/**
 * A question word matches a tag when one is the start of the other, so
 * "roads" finds "road" and "widened" finds "widen". Four letters minimum, or
 * short words would match almost anything.
 */
function matchesTag(word: string, tags: string[]): boolean {
  return tags.some((tag) =>
    word === tag || (Math.min(word.length, tag.length) >= 4 && (word.startsWith(tag) || tag.startsWith(word))));
}

async function askPlanner(question: string) {
  const [busiest, damage] = await Promise.all([
    hotspots(5),
    load<RoadDamagePoint[]>("get/road-damage-priority.json"),
  ]);
  const facts = [
    ...busiest.map((h) => ({
      text: `${h.intersection_name} currently has the #${h.rank} highest congestion score ` +
            `in the city at ${h.congestion_score}/100.`,
      tags: CONGESTION_TAGS,
    })),
    ...damage.slice(0, 5).map((d) => ({
      text: `${d.name} has a detected ${d.damage_type.replace(/_/g, " ")} ` +
            `with severity ${d.severity} (confidence ${d.confidence}).`,
      tags: MAINTENANCE_TAGS,
    })),
  ];

  const tokens = new Set(
    question.split(/\s+/).filter(Boolean).map((w) => w.replace(/^[.,?!]+|[.,?!]+$/g, "").toLowerCase()),
  );
  const score = (tags: string[]) => Array.from(tokens).filter((t) => matchesTag(t, tags)).length;
  const used = facts
    .map((fact, order) => ({ fact, order, score: score(fact.tags) }))
    .filter((f) => f.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, 5)
    .map((f) => f.fact.text);

  if (!used.length) {
    return {
      answer:
        "I don't have enough current data to answer that precisely. " +
        "Try asking about congestion, complaints, road condition, or " +
        "recent accidents at a specific intersection or road.",
      sources_used: [],
    };
  }
  return {
    answer:
      `Based on current city data: ${used.join(" ")} ` +
      `This answer draws on ${used.length} data point(s) retrieved for your question.`,
    sources_used: used,
  };
}

/* ------------------------------------------------- road tiles (bbox reads) */

interface BoxedLink {
  link: RoadLinkGeo;
  south: number; west: number; north: number; east: number;
}

const MAX_TILES_PER_REQUEST = 80;
const MAX_TILES_HELD = 160;
const tiles = new Map<string, Promise<BoxedLink[]>>();
let tileNames: Promise<{ cell: number; names: Set<string> }> | undefined;

function tileIndex() {
  tileNames ??= load<{ cell: number; tiles: string[] }>("roads/index.json").then((index) => ({
    cell: index.cell,
    names: new Set(index.tiles),
  }));
  return tileNames;
}

function tile(name: string): Promise<BoxedLink[]> {
  let hit = tiles.get(name);
  if (!hit) {
    hit = fetchData(`roads/${name}.json`)
      .then((res) => res.json() as Promise<RoadLinkGeo[]>)
      .then((links) =>
        links.map((link) => {
          let south = 90, west = 180, north = -90, east = -180;
          for (const [lat, lon] of link.geometry) {
            if (lat < south) south = lat;
            if (lat > north) north = lat;
            if (lon < west) west = lon;
            if (lon > east) east = lon;
          }
          return { link, south, west, north, east };
        }),
      );
    hit.catch(() => tiles.delete(name));
    tiles.set(name, hit);
    // A long session panning across the country would otherwise hold every
    // tile it ever saw; drop the oldest.
    if (tiles.size > MAX_TILES_HELD) tiles.delete(tiles.keys().next().value as string);
  }
  return hit;
}

/** Every link whose bounding box overlaps the area, each once. */
async function linksInBox(south: number, west: number, north: number, east: number): Promise<BoxedLink[]> {
  const { cell, names } = await tileIndex();
  const wanted: string[] = [];
  for (let iy = Math.floor(south / cell); iy <= Math.floor(north / cell); iy++) {
    for (let ix = Math.floor(west / cell); ix <= Math.floor(east / cell); ix++) {
      if (names.has(`${iy}_${ix}`)) wanted.push(`${iy}_${ix}`);
    }
  }
  const loaded = await Promise.all(wanted.slice(0, MAX_TILES_PER_REQUEST).map(tile));

  const seen = new Set<number>();
  const out: BoxedLink[] = [];
  for (const entries of loaded) {
    for (const entry of entries) {
      if (seen.has(entry.link.id)) continue;
      if (entry.north < south || entry.south > north || entry.east < west || entry.west > east) continue;
      seen.add(entry.link.id);
      out.push(entry);
    }
  }
  return out;
}

async function roadsInBox(q: URLSearchParams): Promise<Response> {
  const box = (q.get("bbox") ?? "").split(",").map(Number);
  if (box.length !== 4 || box.some(Number.isNaN)) {
    return reply({ detail: "bbox must be four numbers: south,west,north,east" }, 400);
  }
  const [south, west, north, east] = box;
  if (!(-90 <= south && south < north && north <= 90 && -180 <= west && west < east && east <= 180)) {
    return reply({ detail: "bbox out of range or south/west not below north/east" }, 400);
  }
  const classes = q.get("highway")?.split(",").map((h) => h.trim());
  const limit = Math.min(Number(q.get("limit") ?? 1500), 6000);

  const links = (await linksInBox(south, west, north, east))
    .map((entry) => entry.link)
    .filter((link) => !classes || classes.includes(link.highway))
    .sort((a, b) => b.length_m - a.length_m)
    .slice(0, limit);
  return reply(links);
}

/* ------------------------------------- gazetteer (port of services/geocode) */

/** [id, name, name_ar, category, subcategory, emirate, lat, lon, population, importance] */
type PlaceRow = [number, string, string | null, string, string | null, string | null, number, number, number | null, number | null];
/** [name, ref, emirate, total length in metres, lat, lon] */
type StreetRow = [string, string | null, string | null, number, number, number];

interface Indexed<T> { row: T; lower: string; grams: string[] }

/** pg_trgm's trigram set: lower-cased words, padded two spaces before, one after. */
function trigrams(text: string): string[] {
  const out = new Set<string>();
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue;
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  }
  return Array.from(out);
}

function similarity(query: Set<string>, grams: string[]): number {
  let shared = 0;
  for (const g of grams) if (query.has(g)) shared++;
  const union = query.size + grams.length - shared;
  return union ? shared / union : 0;
}

let gazetteer: Promise<{ places: Indexed<PlaceRow>[]; streets: Indexed<StreetRow>[] }> | undefined;

function loadGazetteer() {
  gazetteer ??= Promise.all([
    load<PlaceRow[]>("search/places.json"),
    load<StreetRow[]>("search/streets.json"),
  ]).then(([places, streets]) => ({
    places: places.map((row) => ({ row, lower: row[1].toLowerCase(), grams: trigrams(row[1]) })),
    streets: streets.map((row) => ({ row, lower: row[0].toLowerCase(), grams: trigrams(row[0]) })),
  }));
  gazetteer.catch(() => { gazetteer = undefined; });
  return gazetteer;
}

/** Relevance first, prominence second — see `_rank` in services/geocode.py. */
function rank(sim: number, importance: number, name: string, needle: string, tokens: string[]): number {
  let score = sim * 100;
  if (needle && name.includes(needle)) score += 30;
  if (tokens.length && tokens.every((t) => name.includes(t))) score += 15;
  if (name === needle) score += 25;
  score += Math.min(importance, 40) * 0.4;
  return round(score, 2);
}

const ROAD_WORDS = new Set([
  "road", "rd", "street", "st", "highway", "hwy", "avenue", "ave", "boulevard", "blvd", "corniche",
]);

async function searchPlaces(q: URLSearchParams) {
  const term = (q.get("q") ?? "").trim().split(/\s+/).join(" ").slice(0, 120);
  if (term.length < 2) return [];
  const limit = Math.min(Number(q.get("limit") ?? 12), 50);
  const emirate = q.get("emirate");
  const category = q.get("category");

  const { places, streets } = await loadGazetteer();
  const needle = term.toLowerCase();
  const tokens = needle.split(" ").filter((t) => t.length > 1);
  const grams = new Set(trigrams(term));
  const results: Record<string, unknown>[] = [];

  const placeHits: { place: Indexed<PlaceRow>; sim: number }[] = [];
  for (const place of places) {
    const row = place.row;
    if (emirate && row[5] !== emirate) continue;
    if (category && row[3] !== category) continue;
    const sim = similarity(grams, place.grams);
    if (sim > 0.22 || place.lower.includes(needle) || (row[2] && row[2].toLowerCase().includes(needle))) {
      placeHits.push({ place, sim });
    }
  }
  placeHits.sort((a, b) => b.sim - a.sim);
  for (const { place, sim } of placeHits.slice(0, limit * 6)) {
    const [id, name, nameAr, cat, subcategory, em, lat, lon, population, importance] = place.row;
    results.push({
      type: "place", id, name, name_ar: nameAr, category: cat, subcategory, emirate: em, lat, lon, population,
      score: rank(sim, importance ?? 0, place.lower, needle, tokens) + (name === term ? 1 : 0),
    });
  }

  if (!category || category === "street") {
    // A query that names a road type is asking for the road, not the district
    // or tower that shares its name.
    const roadIntent = needle.split(" ").some((w) => ROAD_WORDS.has(w.replace(/^[.,]+|[.,]+$/g, "")));
    const streetHits: { street: Indexed<StreetRow>; sim: number }[] = [];
    for (const street of streets) {
      if (emirate && street.row[2] !== emirate) continue;
      const sim = similarity(grams, street.grams);
      if (sim > 0.3 || street.lower.includes(needle)) streetHits.push({ street, sim });
    }
    streetHits.sort((a, b) => b.sim - a.sim);
    for (const { street, sim } of streetHits.slice(0, limit)) {
      const [name, ref, em, lengthM, lat, lon] = street.row;
      const lengthKm = lengthM / 1000;
      const importance = Math.min(40, 20 + lengthKm / 5);
      results.push({
        type: "street", id: null, name, ref, category: "street", subcategory: "road", emirate: em,
        lat, lon, length_km: round(lengthKm, 2),
        score: round(rank(sim, importance, street.lower, needle, tokens) + (roadIntent ? 12 : 0), 2),
      });
    }
  }

  // The same feature legitimately arrives more than once (OSM tags a hospital
  // as both amenity and building; a long road is split by ref). Fold them.
  const deduped = new Map<string, Record<string, unknown>>();
  for (const r of results) {
    const name = String(r.name).trim().toLowerCase();
    const key = r.type === "street"
      ? `street|${name}|${r.emirate}`
      : `${name}|${round(r.lat as number, 3)}|${round(r.lon as number, 3)}`;
    const kept = deduped.get(key);
    if (!kept || (r.score as number) > (kept.score as number)) deduped.set(key, r);
  }
  return Array.from(deduped.values())
    .sort((a, b) => (b.score as number) - (a.score as number))
    .slice(0, limit);
}

async function listPlaces(q: URLSearchParams) {
  const { places } = await loadGazetteer();
  const emirate = q.get("emirate");
  const categories = q.get("category")?.split(",").map((c) => c.trim());
  const subcategory = q.get("subcategory");
  const minImportance = Number(q.get("min_importance") ?? 0);
  const limit = Math.min(Number(q.get("limit") ?? 500), 5000);

  const out = [];
  // The index is stored importance-first, so the first matches are the answer.
  for (const { row } of places) {
    if ((row[9] ?? 0) < minImportance) break;
    if (emirate && row[5] !== emirate) continue;
    if (categories && !categories.includes(row[3])) continue;
    if (subcategory && row[4] !== subcategory) continue;
    out.push({
      id: row[0], name: row[1], name_ar: row[2], category: row[3], subcategory: row[4],
      emirate: row[5], lat: row[6], lon: row[7], population: row[8], importance: row[9],
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Closest point on segment a→b to p, on a plane with longitude scaled by `kx`. */
function closestOnSegment(
  plat: number, plon: number, alat: number, alon: number, blat: number, blon: number, kx: number,
): [number, number] {
  const dx = (blon - alon) * kx;
  const dy = blat - alat;
  const span = dx * dx + dy * dy;
  const t = span === 0 ? 0 : Math.max(0, Math.min(1, (((plon - alon) * kx) * dx + (plat - alat) * dy) / span));
  return [alat + (blat - alat) * t, alon + (blon - alon) * t];
}

/** Metres from a point to a polyline of [lat, lon] vertices. */
export function distanceToLineM(lat: number, lon: number, line: [number, number][]): number {
  const kx = Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const [clat, clon] = closestOnSegment(lat, lon, line[i][0], line[i][1], line[i + 1][0], line[i + 1][1], kx);
    const d = haversineKm(lat, lon, clat, clon) * 1000;
    if (d < best) best = d;
  }
  return best;
}

async function reverseGeocode(q: URLSearchParams): Promise<Response> {
  const lat = Number(q.get("lat"));
  const lon = Number(q.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return reply({ detail: "lat and lon must be valid coordinates" }, 422);
  }
  const radiusM = Math.min(Number(q.get("radius_m") ?? 1500), 20000);
  const deg = radiusM / 111_320;

  const [{ places }, links] = await Promise.all([
    loadGazetteer(),
    linksInBox(lat - deg, lon - deg, lat + deg, lon + deg),
  ]);

  const out: Record<string, any> = { query: { lat, lon } };

  let nearestPlace: PlaceRow | undefined;
  let placeDistance = Infinity;
  for (const { row } of places) {
    if (Math.hypot(row[6] - lat, row[7] - lon) > deg) continue;
    const d = haversineKm(lat, lon, row[6], row[7]) * 1000;
    if (d < placeDistance) [nearestPlace, placeDistance] = [row, d];
  }
  if (nearestPlace) {
    out.place = {
      name: nearestPlace[1], category: nearestPlace[3], subcategory: nearestPlace[4],
      emirate: nearestPlace[5], lat: nearestPlace[6], lon: nearestPlace[7],
      distance_m: round(placeDistance, 1),
    };
  }

  let nearestRoad: RoadLinkGeo | undefined;
  let roadDistance = radiusM;
  for (const { link } of links) {
    if (!link.name) continue;
    const d = distanceToLineM(lat, lon, link.geometry);
    if (d < roadDistance) [nearestRoad, roadDistance] = [link, d];
  }
  if (nearestRoad) {
    out.street = {
      name: nearestRoad.name, ref: nearestRoad.ref, highway: nearestRoad.highway,
      emirate: nearestRoad.emirate, distance_m: round(roadDistance, 1),
    };
  }

  if (!out.place && !out.street) {
    out.error = `nothing named within ${radiusM.toFixed(0)} m`;
  } else {
    // The nearest named place is often the city itself, which would repeat the
    // emirate; keep the first occurrence of each part.
    const seen = new Set<string>();
    out.label = [out.street?.name, out.place?.name, (out.street ?? out.place)?.emirate]
      .filter((part): part is string => {
        if (!part || seen.has(part.toLowerCase())) return false;
        seen.add(part.toLowerCase());
        return true;
      })
      .join(", ");
  }
  return reply(out);
}

/* --------------------------------------------- dispatch and corridor design */

async function nearestFacility(q: URLSearchParams): Promise<Response> {
  const lat = Number(q.get("lat"));
  const lon = Number(q.get("lon"));
  const kind = q.get("facility_type") ?? "hospital";
  const incidents = await load<{ lat: number; lon: number }[]>("emergency/index.json");
  const i = incidents.findIndex((p) => Math.abs(p.lat - lat) < 1e-4 && Math.abs(p.lon - lon) < 1e-4);
  if (i < 0) {
    return reply({ detail: "Dispatch routing is published for the listed incident locations." }, 404);
  }
  return reply(await load(`emergency/${i}-${kind}.json`));
}

interface DesignRequest {
  origin_lat: number; origin_lon: number; dest_lat: number; dest_lon: number;
  origin_name?: string; destination_name?: string; lanes?: number;
}

async function analyseRoute(body: DesignRequest): Promise<Response> {
  const lanes = body.lanes ?? 6;
  if (!Number.isInteger(lanes) || lanes < 2 || lanes > 12) {
    const msg = lanes < 2 ? "Input should be greater than or equal to 2" : "Input should be less than or equal to 12";
    return reply({ detail: [{ loc: ["body", "lanes"], msg }] }, 422);
  }
  if (body.origin_lat === body.dest_lat && body.origin_lon === body.dest_lon) {
    return reply({ detail: "Origin and destination are the same point." }, 400);
  }

  // The studied corridors are recorded from the API; anything else is worked
  // out here over the same routing graph.
  const presets = (await recorded<DesignPreset[]>("/api/route-design/presets")) ?? [];
  const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  const preset = presets.find((p) =>
    close(p.origin_lat, body.origin_lat) && close(p.origin_lon, body.origin_lon) &&
    close(p.dest_lat, body.dest_lat) && close(p.dest_lon, body.dest_lon));
  if (preset) return reply(await load(`route-design/${preset.id}-${lanes}.json`));

  const { designRoute } = await import("@/lib/routing");
  return reply(await designRoute({
    origin: [body.origin_lat, body.origin_lon],
    destination: [body.dest_lat, body.dest_lon],
    originName: body.origin_name || "Origin",
    destinationName: body.destination_name || "Destination",
    lanes,
  }));
}

/* ------------------------------------------------------------------ router */

const parseBody = (init?: RequestInit) =>
  typeof init?.body === "string" && init.body ? JSON.parse(init.body) : {};

/** Console actions whose result is fixed by the published data set. */
const RECORDED_ACTIONS: Record<string, string> = {
  "/api/cameras/seed-sites": "actions/cameras-seed-sites.json",
  "/api/cameras/health-sweep": "actions/cameras-health-sweep.json",
  "/api/infrastructure/seed": "actions/infrastructure-seed.json",
};

/** Imports that would refetch from OpenStreetMap: the published set is current. */
const IMPORTS = new Set(["/api/network/ingest", "/api/network/ingest-streets", "/api/places/ingest"]);

export async function staticFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = new URL(path, "http://static.local");
  const route = url.pathname.replace(/\/+$/, "");
  const q = url.searchParams;
  const method = (init?.method ?? "GET").toUpperCase();

  if (method === "GET") {
    switch (route) {
      case "/api/traffic/live":
        return reply(await liveTraffic());
      case "/api/traffic/hotspots":
        return reply(await hotspots(Number(q.get("limit") ?? 5)));
      case "/api/digital-twin/layers":
        return reply(await digitalTwinLayers());
      case "/api/analytics/kpis":
        return reply(await kpis());
      case "/api/analytics/history/congestion":
        return reply(await congestionHistory(q));
      case "/api/road-damage/priority":
        return reply(
          (await load<RoadDamagePoint[]>("get/road-damage-priority.json")).slice(0, Number(q.get("limit") ?? 10)),
        );
      case "/api/complaints":
        return reply(await listComplaints());
      case "/api/places/search":
        return reply(await searchPlaces(q));
      case "/api/places/reverse":
        return reverseGeocode(q);
      case "/api/emergency/nearest-facility":
        return nearestFacility(q);
      case "/api/network/roads":
        if (q.has("bbox")) return roadsInBox(q);
        break;
    }
    const hit = (await recorded(canonical(route, q))) ?? (Array.from(q.keys()).length ? undefined : await recorded(route));
    if (hit !== undefined) return reply(hit);
    if (route === "/api/places") return reply(await listPlaces(q));
    return reply({ detail: "Not found" }, 404);
  }

  if (method === "POST") {
    if (route === "/api/auth/logout") return reply({ ok: true });
    if (route === "/api/complaints") return submitComplaint(parseBody(init));
    if (route === "/api/planner/ask") return reply(await askPlanner(String(parseBody(init).question ?? "")));
    if (route === "/api/route-design/analyze") return analyseRoute(parseBody(init));
    if (route in RECORDED_ACTIONS) return reply(await load(RECORDED_ACTIONS[route]));
    if (IMPORTS.has(route)) return reply({ status: "up_to_date" });

    const probe = /^\/api\/cameras\/(\d+)\/test$/.exec(route);
    if (probe) {
      const result = await load(`actions/camera-test-${probe[1]}.json`).catch(() => undefined);
      return result ? reply(result) : reply({ detail: "Camera not found" }, 404);
    }
  }

  return reply({ detail: "This action needs the application server and is not part of the hosted edition." }, 405);
}
