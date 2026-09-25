"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { api, describeError, Facility } from "@/lib/api";

const MapView = dynamic(() => import("@/components/MapView"), { ssr: false });

// Realistic incident locations for a dispatch drill.
const INCIDENT_PRESETS = [
  { name: "Sheikh Zayed Rd @ Interchange 2", lat: 25.2180, lon: 55.2790 },
  { name: "Al Garhoud Bridge", lat: 25.2450, lon: 55.3320 },
  { name: "Dubai Marina", lat: 25.0780, lon: 55.1400 },
  { name: "Abu Dhabi Corniche", lat: 24.4750, lon: 54.3400 },
];

const TYPES = [
  { value: "hospital", label: "Ambulance → Hospital" },
  { value: "fire", label: "Fire / Civil Defence" },
  { value: "police", label: "Police" },
];

export default function DispatchPage() {
  const [incident, setIncident] = useState(INCIDENT_PRESETS[0]);
  const [type, setType] = useState("hospital");
  const [candidates, setCandidates] = useState<Facility[]>([]);
  const [recommended, setRecommended] = useState<Facility | null>(null);
  const [realNetwork, setRealNetwork] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function dispatch(lat: number, lon: number, facilityType: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.nearestFacility(lat, lon, facilityType);
      setCandidates(res.candidates || []);
      setRecommended(res.recommended);
      setRealNetwork(res.routed_on_real_network);
      if (!res.routed_on_real_network) {
        setError(
          "Road network not ingested — ranking is straight-line only. Run M10 → INGEST NETWORK for real drive times."
        );
      }
    } catch (e) {
      setError(describeError(e, "Dispatch lookup failed."));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    dispatch(incident.lat, incident.lon, type);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incident, type]);

  return (
    <div className="p-6 space-y-6">
      <header className="border-b hairline pb-4">
        <h1 className="font-display text-2xl text-paper">Emergency Dispatch</h1>
        <p className="font-mono text-[11px] text-blueprint-line/60 mt-1">
          M7 — fastest-response routing over the real network · blue-light timing
        </p>
      </header>

      <section className="flex flex-wrap gap-4 items-end">
        <div>
          <div className="font-mono text-[10px] text-blueprint-line/60 mb-1">INCIDENT LOCATION</div>
          <div className="flex flex-wrap gap-2">
            {INCIDENT_PRESETS.map((p) => (
              <button
                key={p.name}
                onClick={() => setIncident(p)}
                className={`border hairline px-3 py-1.5 font-mono text-[10px] ${
                  incident.name === p.name
                    ? "border-signal-red text-paper bg-blueprint-800/60"
                    : "text-paper/60 hover:text-paper"
                }`}
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="font-mono text-[10px] text-blueprint-line/60 mb-1">SERVICE</div>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="bg-blueprint-800 border hairline px-2 py-1.5 text-xs font-mono text-paper focus:outline-none focus:border-signal-amber"
          >
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>
      </section>

      {error && (
        <div role="alert" className="border border-signal-amber/40 bg-signal-amber/10 text-signal-amber text-xs font-mono px-4 py-3">
          {error}
        </div>
      )}

      <section className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <div className="lg:col-span-3 blueprint-frame border hairline h-[55vh] min-h-[300px] lg:h-[460px] overflow-hidden">
          <MapView
            route={recommended?.geometry as [number, number][] | undefined}
            traffic={[
              {
                intersection_id: -1,
                intersection_name: `INCIDENT — ${incident.name}`,
                lat: incident.lat,
                lon: incident.lon,
                ts: new Date().toISOString(),
                vehicle_count: 0,
                avg_speed_kmh: 0,
                congestion_score: 100,
                queue_length_m: 0,
                lane_occupancy_pct: 0,
              },
            ]}
            center={[incident.lat, incident.lon]}
            zoom={11}
          />
        </div>

        <div className="lg:col-span-2 space-y-3">
          {recommended && (
            <div className="blueprint-frame border border-signal-green/40 bg-signal-green/5 p-4">
              <div className="font-mono text-[10px] text-signal-green mb-1">DISPATCH →</div>
              <div className="text-sm text-paper">{recommended.name}</div>
              <div className="font-display text-3xl text-signal-green mt-2">
                {recommended.eta_minutes ?? "—"}
                <span className="text-sm text-paper/50 ml-1">min</span>
              </div>
              <div className="font-mono text-[10px] text-paper/50 mt-1">
                {recommended.distance_km ? `${recommended.distance_km} km by road` : ""}
                {recommended.straight_line_km
                  ? ` · ${recommended.straight_line_km} km straight line`
                  : ""}
              </div>
            </div>
          )}

          <div className="blueprint-frame border hairline overflow-hidden">
            <div className="px-4 py-2 font-mono text-[10px] text-blueprint-line/60 border-b hairline">
              ALL CANDIDATES {realNetwork && "(ranked by real drive time)"}
            </div>
            <table className="w-full text-xs font-mono">
              <tbody>
                {busy && (
                  <tr>
                    <td className="px-4 py-6 text-center text-paper/40">Routing…</td>
                  </tr>
                )}
                {!busy && candidates.length === 0 && (
                  <tr>
                    <td className="px-4 py-6 text-center text-paper/40">No facilities found.</td>
                  </tr>
                )}
                {!busy &&
                  candidates.map((f) => (
                    <tr key={f.id} className="border-t hairline">
                      <td className="px-4 py-2">
                        <div className="text-paper/85">
                          {f.rank}. {f.name}
                        </div>
                        <div className="text-[10px] text-paper/40">{f.emirate}</div>
                      </td>
                      <td className="px-4 py-2 text-right">
                        <div className={f.rank === 1 ? "text-signal-green" : "text-paper/70"}>
                          {f.eta_minutes ? `${f.eta_minutes} min` : `${f.straight_line_km} km`}
                        </div>
                        {f.distance_km && (
                          <div className="text-[10px] text-paper/40">{f.distance_km} km</div>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>

          <p className="font-mono text-[10px] text-blueprint-line/40 leading-relaxed">
            Nearest by straight line is often not fastest — a creek crossing or a closed
            interchange changes the answer, so every candidate is routed over the real
            network. Emergency times apply a 0.75 blue-light factor to civilian travel time.
          </p>
        </div>
      </section>
    </div>
  );
}
