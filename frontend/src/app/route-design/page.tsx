"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { api, describeError, DesignPreset, RouteDesign } from "@/lib/api";

const MapView = dynamic(() => import("@/components/MapView"), { ssr: false });

function scoreTone(score: number) {
  if (score >= 70) return "text-signal-green";
  if (score >= 45) return "text-signal-amber";
  return "text-signal-red";
}

export default function RouteDesignPage() {
  const [presets, setPresets] = useState<DesignPreset[]>([]);
  const [design, setDesign] = useState<RouteDesign | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lanes, setLanes] = useState(6);
  const [form, setForm] = useState({
    origin_name: "", origin_lat: "", origin_lon: "",
    destination_name: "", dest_lat: "", dest_lon: "",
  });

  useEffect(() => {
    api.designPresets().then(setPresets).catch((e) => setError(describeError(e)));
  }, []);

  async function run(payload: {
    origin_lat: number; origin_lon: number; dest_lat: number; dest_lon: number;
    origin_name?: string; destination_name?: string;
  }) {
    setBusy(true);
    setError(null);
    try {
      const result = await api.analyzeRoute({ ...payload, lanes });
      setDesign(result);
    } catch (e) {
      setError(describeError(e, "Analysis failed.") + " If this keeps happening, make sure the road network is ingested (Road Network → INGEST NETWORK).");
    } finally {
      setBusy(false);
    }
  }

  function runPreset(p: DesignPreset) {
    run({
      origin_lat: p.origin_lat, origin_lon: p.origin_lon,
      dest_lat: p.dest_lat, dest_lon: p.dest_lon,
      origin_name: p.origin_name, destination_name: p.destination_name,
    });
  }

  function runManual(e: React.FormEvent) {
    e.preventDefault();
    const nums = {
      origin_lat: parseFloat(form.origin_lat), origin_lon: parseFloat(form.origin_lon),
      dest_lat: parseFloat(form.dest_lat), dest_lon: parseFloat(form.dest_lon),
    };
    if (Object.values(nums).some((n) => Number.isNaN(n))) {
      setError("All four coordinates must be numbers.");
      return;
    }
    if (Math.abs(nums.origin_lat) > 90 || Math.abs(nums.dest_lat) > 90) {
      setError("Latitude must be between -90 and 90.");
      return;
    }
    if (Math.abs(nums.origin_lon) > 180 || Math.abs(nums.dest_lon) > 180) {
      setError("Longitude must be between -180 and 180.");
      return;
    }
    if (nums.origin_lat === nums.dest_lat && nums.origin_lon === nums.dest_lon) {
      setError("Origin and destination are the same point.");
      return;
    }
    run({
      ...nums,
      origin_name: form.origin_name || "Origin",
      destination_name: form.destination_name || "Destination",
    });
  }

  return (
    <div className="p-6 space-y-6">
      <header className="border-b hairline pb-4">
        <h1 className="font-display text-2xl text-paper">New Route Design</h1>
        <p className="font-mono text-[11px] text-blueprint-line/60 mt-1">
          M12 — corridor assessment · detour analysis · costed build options
        </p>
      </header>

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-2">
          <div className="font-mono text-[10px] text-blueprint-line/60">STUDY A CORRIDOR</div>
          <div className="flex flex-wrap gap-2">
            {presets.map((p) => (
              <button
                key={p.id}
                onClick={() => runPreset(p)}
                disabled={busy}
                title={p.why}
                className="border hairline px-3 py-1.5 font-mono text-[10px] text-paper/75 hover:border-signal-amber hover:text-paper disabled:opacity-40"
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-end gap-2">
          <label htmlFor="rd-lanes" className="font-mono text-[10px] text-blueprint-line/60">
            LANES
            <input
              id="rd-lanes"
              type="number"
              min={2}
              max={12}
              value={lanes}
              onChange={(e) => setLanes(parseInt(e.target.value) || 6)}
              className="ml-2 w-16 bg-blueprint-800 border hairline px-2 py-1 text-xs font-mono text-paper focus:outline-none focus:border-signal-amber"
            />
          </label>
        </div>
      </section>

      <form onSubmit={runManual} className="blueprint-frame border hairline p-4">
        <div className="font-mono text-[10px] text-blueprint-line/60 mb-3">
          OR ENTER COORDINATES
        </div>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
          {([
            ["origin_name", "Origin name", "text"],
            ["origin_lat", "Origin lat", "text"],
            ["origin_lon", "Origin lon", "text"],
            ["destination_name", "Dest name", "text"],
            ["dest_lat", "Dest lat", "text"],
            ["dest_lon", "Dest lon", "text"],
          ] as const).map(([key, label, type]) => (
            <input
              key={key}
              type={type}
              placeholder={label}
              aria-label={label}
              inputMode={key.includes("name") ? "text" : "decimal"}
              required={!key.includes("name")}
              value={(form as any)[key]}
              onChange={(e) => setForm({ ...form, [key]: e.target.value })}
              className="bg-blueprint-800 border hairline px-2 py-1.5 text-xs font-mono text-paper placeholder:text-paper/30 focus:outline-none focus:border-signal-amber"
            />
          ))}
        </div>
        <button
          type="submit"
          disabled={busy}
          className="mt-3 border hairline px-4 py-1.5 font-mono text-[11px] bg-signal-amber/80 text-blueprint-950 hover:bg-signal-amber disabled:opacity-40"
        >
          {busy ? "ANALYSING…" : "ANALYSE CORRIDOR"}
        </button>
      </form>

      {error && (
        <div role="alert" className="border border-signal-red/40 bg-signal-red/10 text-signal-red text-xs font-mono px-4 py-3">
          {error}
        </div>
      )}

      {design && (
        <section className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          <div className="lg:col-span-3 blueprint-frame border hairline h-[55vh] min-h-[300px] lg:h-[460px] overflow-hidden">
            <MapView
              route={design.existing_route.geometry as [number, number][]}
              proposedRoute={design.proposed.geometry as [number, number][]}
              center={[
                (design.origin.lat + design.destination.lat) / 2,
                (design.origin.lon + design.destination.lon) / 2,
              ]}
              zoom={10}
            />
          </div>

          <div className="lg:col-span-2 space-y-4">
            <div className="blueprint-frame border hairline p-4">
              <div className="flex items-baseline justify-between">
                <div className="font-mono text-[10px] text-blueprint-line/60">
                  FEASIBILITY
                </div>
                <div className={`font-display text-3xl ${scoreTone(design.feasibility_score)}`}>
                  {design.feasibility_score}
                  <span className="text-sm text-paper/40">/100</span>
                </div>
              </div>
              <div className="text-xs text-paper/80 mt-2 leading-relaxed">
                {design.recommendation}
              </div>
              <div className="text-[11px] text-paper/55 mt-2 leading-relaxed font-mono">
                {design.rationale}
              </div>
            </div>

            <div className="blueprint-frame border hairline p-4 space-y-2 font-mono text-[11px]">
              <div className="text-[10px] text-blueprint-line/60 mb-1">TODAY vs PROPOSED</div>
              <Row label="Straight line" value={`${design.straight_line_km} km`} />
              <Row
                label="Network distance"
                value={design.existing_route.distance_km ? `${design.existing_route.distance_km} km` : "no route"}
              />
              <Row
                label="Detour ratio"
                value={design.existing_route.detour_ratio ?? "—"}
                tone={
                  design.existing_route.detour_ratio && design.existing_route.detour_ratio >= 1.45
                    ? "text-signal-red"
                    : undefined
                }
              />
              <Row
                label="Travel time now"
                value={design.existing_route.travel_time_min ? `${design.existing_route.travel_time_min} min` : "—"}
              />
              <div className="border-t hairline my-2" />
              <Row label="Strategy" value={design.proposed.strategy.replace("_", " ")} tone="text-signal-amber" />
              <Row label="Build type" value={design.proposed.build_type.replace("_", " ")} />
              <Row label="Length" value={`${design.proposed.length_km} km`} />
              <Row label="Capacity" value={`${design.proposed.capacity_vph.toLocaleString()} v/h`} />
              <Row label="Est. travel time" value={`${design.proposed.est_travel_time_min} min`} />
              <Row
                label="Time saving"
                value={design.proposed.time_saving_pct !== null ? `${design.proposed.time_saving_pct}%` : "—"}
                tone="text-signal-green"
              />
              <Row label="Est. cost" value={`AED ${design.proposed.est_cost_aed_m}m`} />
            </div>

            <div className="blueprint-frame border hairline p-4 font-mono text-[11px]">
              <div className="text-[10px] text-blueprint-line/60 mb-2">CORRIDOR GAP</div>
              {Object.entries(design.corridor_gap).map(([k, v]) => (
                <Row key={k} label={k.replace(/_/g, " ")} value={String(v)} />
              ))}
            </div>

            {design.conflicts.length > 0 && (
              <div className="blueprint-frame border hairline p-4">
                <div className="font-mono text-[10px] text-blueprint-line/60 mb-2">
                  ALREADY PLANNED NEARBY
                </div>
                {design.conflicts.map((c) => (
                  <div key={c.id} className="border-t hairline py-2 font-mono text-[11px]">
                    <div className="text-paper/85">{c.name}</div>
                    <div className="text-paper/45 text-[10px]">
                      {c.status.replace("_", " ")} · {c.distance_km} km away
                      {c.authority && ` · ${c.authority}`}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <p className="font-mono text-[10px] text-blueprint-line/40 leading-relaxed">
              {design.method_note}
            </p>
          </div>
        </section>
      )}
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-paper/50 capitalize">{label}</span>
      <span className={tone ?? "text-paper/90"}>{value}</span>
    </div>
  );
}
