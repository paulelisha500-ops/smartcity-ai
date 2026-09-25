"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  api, TrafficReading, RoadDamagePoint, Hotspot, KPIs,
  RoadLinkGeo, BorderCrossingRow, CameraRow, Project,
} from "@/lib/api";
import type { PlaceMarker } from "@/components/MapView";
import { useLiveSocket, LiveEvent, NewComplaintEvent } from "@/lib/live";
import KPICard from "@/components/KPICard";
import CongestionChart from "@/components/CongestionChart";

const MapView = dynamic(() => import("@/components/MapView"), { ssr: false });

export default function DashboardPage() {
  const [traffic, setTraffic] = useState<TrafficReading[]>([]);
  const [damage, setDamage] = useState<RoadDamagePoint[]>([]);
  const [hotspots, setHotspots] = useState<Hotspot[]>([]);
  const [kpis, setKpis] = useState<KPIs | null>(null);
  const [connError, setConnError] = useState(false);

  // Context layers — each is optional, so the dashboard still works before
  // the network is ingested or any camera is registered.
  const [roads, setRoads] = useState<RoadLinkGeo[]>([]);
  const [borders, setBorders] = useState<BorderCrossingRow[]>([]);
  const [cameras, setCameras] = useState<CameraRow[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [places, setPlaces] = useState<PlaceMarker[]>([]);
  const [networkKm, setNetworkKm] = useState<number | null>(null);
  const [placeCount, setPlaceCount] = useState<number | null>(null);
  const [recentComplaints, setRecentComplaints] = useState<NewComplaintEvent[]>([]);

  // The poll loop below is a closure captured once by setInterval; a ref lets
  // the WebSocket handler (registered in a separate effect) call the latest
  // version without re-subscribing the socket every time it's redefined.
  const loadLiveRef = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    let failedPolls = 0;

    async function loadLive() {
      try {
        const [layers, hs, k] = await Promise.all([
          api.digitalTwinLayers(),
          api.hotspots(6),
          api.kpis(),
        ]);
        if (cancelled) return;
        setTraffic(layers.traffic);
        setDamage(layers.road_damage);
        setHotspots(hs);
        setKpis(k);
        failedPolls = 0;
        setConnError(false);
      } catch {
        // One dropped poll (a slow connection, a backend restart) shouldn't
        // flash a red banner over a working dashboard; two in a row means the
        // API really is unreachable.
        if (!cancelled) {
          failedPolls += 1;
          if (failedPolls >= 2) setConnError(true);
        }
      }
    }
    loadLiveRef.current = loadLive;

    async function loadContext() {
      // Settled, not all: a missing layer must not blank the whole map.
      const [status, roadRes, borderRes, camRes, projRes, placeRes, placeStatus] =
        await Promise.allSettled([
          api.networkStatus(),
          api.roads({ highway: "motorway,trunk", limit: 500 }),
          api.borderCrossings(),
          api.cameras(),
          api.projects(),
          // The dashboard is a country-level view: only the heaviest names,
          // so labels stay legible. The network page carries the full set.
          api.places({ category: "place", limit: 400 }),
          api.placesStatus(),
        ]);
      if (cancelled) return;
      if (status.status === "fulfilled") setNetworkKm(status.value.network_km);
      if (roadRes.status === "fulfilled") setRoads(roadRes.value);
      if (borderRes.status === "fulfilled") setBorders(borderRes.value);
      if (camRes.status === "fulfilled") setCameras(camRes.value);
      if (projRes.status === "fulfilled") setProjects(projRes.value);
      if (placeRes.status === "fulfilled") setPlaces(placeRes.value as PlaceMarker[]);
      if (placeStatus.status === "fulfilled") setPlaceCount(placeStatus.value.total_places);
    }

    loadLive();
    loadContext();
    const interval = setInterval(loadLive, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Debounced KPI refresh: several new_complaint events arriving together
  // (a batch import, a busy few minutes) should trigger one refetch, not one
  // per event.
  const kpiRefreshTimer = useRef<ReturnType<typeof setTimeout>>();
  const refreshKpisSoon = useCallback(() => {
    clearTimeout(kpiRefreshTimer.current);
    kpiRefreshTimer.current = setTimeout(() => loadLiveRef.current(), 1500);
  }, []);

  const handleLiveEvent = useCallback((event: LiveEvent) => {
    if (event.type === "congestion_update") {
      // Patch the matching intersection in place rather than refetching —
      // this is what makes the map feel live between the 15s polls, and it's
      // the same partial-update shape a real CV pipeline's per-frame output
      // would carry (a score, not a full re-derivation of every field).
      setTraffic((prev) =>
        prev.map((t) =>
          t.intersection_id === event.intersection_id
            ? { ...t, congestion_score: event.congestion_score }
            : t
        )
      );
    } else if (event.type === "new_complaint") {
      setRecentComplaints((prev) => [event, ...prev].slice(0, 5));
      refreshKpisSoon();
    } else if (event.type === "camera_status") {
      setCameras((prev) =>
        prev.map((c) => (c.id === event.camera_id ? { ...c, status: event.status } : c))
      );
    }
  }, [refreshKpisSoon]);

  const { connected: liveConnected } = useLiveSocket(handleLiveEvent);

  return (
    <div className="p-6 space-y-6">
      <header className="flex items-end justify-between border-b hairline pb-4">
        <div>
          <h1 className="font-display text-2xl text-paper">Digital Twin — UAE City Operations</h1>
          <p className="font-mono text-[11px] text-blueprint-line/60 mt-1">
            {networkKm ? `${Math.round(networkKm).toLocaleString()} km of road network` : ""}
            {placeCount ? ` · ${placeCount.toLocaleString()} named places` : ""}
            {cameras.length > 0 ? ` · ${cameras.length} cameras` : ""}
          </p>
        </div>
        <div role="status" aria-live="polite" className="flex items-center gap-2 font-mono text-[11px]" title={
          liveConnected ? "Connected to /ws/live" : "Reconnecting to /ws/live…"
        }>
          <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${
            liveConnected ? "bg-signal-green animate-pulse" : "bg-blueprint-line/40"
          }`} />
          <span className={liveConnected ? "text-signal-green" : "text-blueprint-line/50"}>
            {liveConnected ? "LIVE" : "RECONNECTING"}
          </span>
        </div>
      </header>

      {connError && (
        <div role="alert" className="border border-signal-red/40 bg-signal-red/10 text-signal-red text-xs font-mono px-4 py-3 rounded-md">
          Can&apos;t reach the backend API. Run <code>docker compose up -d</code> and confirm
          NEXT_PUBLIC_API_URL points to it.
        </div>
      )}

      <section className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <KPICard code="M8.1" label="Congestion index" value={kpis?.congestion_index ?? "—"} unit="/100" tone={kpis && kpis.congestion_index > 65 ? "bad" : "default"} />
        <KPICard code="M8.2" label="Avg speed" value={kpis?.avg_speed_kmh ?? "—"} unit="km/h" />
        <KPICard code="M8.3" label="Road quality" value={kpis?.road_quality_score ?? "—"} unit="/100" tone={kpis && kpis.road_quality_score < 60 ? "warn" : "good"} />
        <KPICard code="M8.4" label="Complaints" value={kpis?.complaint_count ?? "—"} />
        <KPICard code="M8.5" label="Resolution rate" value={kpis?.complaint_resolution_rate_pct ?? "—"} unit="%" tone="good" />
        <KPICard code="M8.6" label="Satisfaction" value={kpis?.public_satisfaction_proxy_pct ?? "—"} unit="%" tone="good" />
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 blueprint-frame border hairline rounded-lg h-[55vh] min-h-[300px] lg:h-[520px] overflow-hidden">
          <MapView
            places={places}
            traffic={traffic}
            roadDamage={damage}
            roads={roads}
            borders={borders}
            cameras={cameras}
            projects={projects}
            center={[24.9, 55.2]}
            zoom={8}
          />
        </div>
        <div className="space-y-6">
          <div className="blueprint-frame border hairline rounded-lg p-4 bg-blueprint-800/30">
            <div className="font-mono text-[10px] text-blueprint-line/60 mb-2">
              M1 — WORST CONGESTION, RIGHT NOW
            </div>
            {hotspots.length > 0 ? (
              <CongestionChart hotspots={hotspots} />
            ) : (
              <div className="text-xs text-paper/40 font-mono py-8 text-center">Waiting for data…</div>
            )}
          </div>

          <div className="blueprint-frame border hairline rounded-lg p-4 bg-blueprint-800/30">
            <div className="font-mono text-[10px] text-blueprint-line/60 mb-2">
              M3 — LIVE COMPLAINT FEED
            </div>
            {recentComplaints.length > 0 ? (
              <ul className="space-y-2">
                {recentComplaints.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-paper/80 truncate">
                      {(c.category ?? "uncategorised").replace(/_/g, " ")}
                      {c.department ? ` → ${c.department.replace(/_/g, " ")}` : ""}
                    </span>
                    <span className={`font-mono text-[10px] shrink-0 ${
                      c.priority === "critical" || c.priority === "high"
                        ? "text-signal-red" : "text-blueprint-line/50"
                    }`}>
                      {c.priority ?? "—"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-xs text-paper/40 font-mono py-8 text-center">
                Waiting for a citizen report…
              </div>
            )}
          </div>
        </div>
      </section>

      <footer className="font-mono text-[10px] text-blueprint-line/40 pt-2">
        Legend — traffic: green light · amber moderate · red heavy ·
        roads: cyan motorway, green trunk, purple cross-border ·
        places: white settlement, red amenity, amber landmark, cyan building ·
        cameras: green online, amber unauthorised · projects: ringed markers.
        Toggle layers with the control at the top-right of the map.
      </footer>
    </div>
  );
}
