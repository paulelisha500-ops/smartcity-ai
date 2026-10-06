"use client";

import { useEffect, useState } from "react";
import { api, describeError, Forecast, TrafficReading, Hotspot } from "@/lib/api";
import ErrorBanner from "@/components/ErrorBanner";
import CongestionChart from "@/components/CongestionChart";
import TrendChart from "@/components/TrendChart";

/** The API's timestamps are UTC without an offset; shown in local time. */
const hourLabel = (iso: string) =>
  new Date(/Z$|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`)
    .toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

export default function TrafficPage() {
  const [readings, setReadings] = useState<TrafficReading[]>([]);
  const [hotspots, setHotspots] = useState<Hotspot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [forecastFor, setForecastFor] = useState<number | null>(null);
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [forecastError, setForecastError] = useState<string | null>(null);

  useEffect(() => {
    api.liveTraffic().then(setReadings).catch((e) => setError(describeError(e)));
    api.hotspots(8).then(setHotspots).catch((e) => setError(describeError(e)));
  }, []);

  // Forecast the worst junction until the user picks another.
  useEffect(() => {
    if (forecastFor === null && hotspots.length) setForecastFor(hotspots[0].intersection_id);
  }, [hotspots, forecastFor]);

  useEffect(() => {
    if (forecastFor === null) return;
    let current = true;
    // Clear the last junction's curve, or it sits under the new junction's name until the answer arrives.
    setForecast(null);
    setForecastError(null);
    api.forecast(forecastFor, 24)
      .then((f) => { if (current) setForecast(f); })
      .catch((e) => {
        if (!current) return;
        setForecast(null);
        setForecastError(describeError(e));
      });
    return () => { current = false; };
  }, [forecastFor]);

  return (
    <div className="p-6 space-y-6">
      <header className="border-b hairline pb-4">
        <h1 className="font-display text-2xl text-paper">Smart Traffic Analysis</h1>
        <p className="font-mono text-[11px] text-blueprint-line/60 mt-1">
          M1 vehicle counts &amp; congestion &middot; M4 congestion forecasting
        </p>
      </header>

      <ErrorBanner message={error} />

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="blueprint-frame border hairline p-4 bg-blueprint-800/30">
          <div className="font-mono text-[10px] text-blueprint-line/60 mb-2">CONGESTION RANKING</div>
          {hotspots.length > 0 && <CongestionChart hotspots={hotspots} />}
        </div>

        <div className="blueprint-frame border hairline overflow-x-auto">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="bg-blueprint-800/60 text-paper/60 uppercase text-[10px]">
                <th className="text-left px-3 py-2">Intersection</th>
                <th className="text-right px-3 py-2">Vehicles</th>
                <th className="text-right px-3 py-2">Speed</th>
                <th className="text-right px-3 py-2">Queue (m)</th>
                <th className="text-right px-3 py-2">Occ %</th>
              </tr>
            </thead>
            <tbody>
              {readings.map((r) => (
                <tr key={r.intersection_id} className="border-t hairline">
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      onClick={() => setForecastFor(r.intersection_id)}
                      aria-pressed={forecastFor === r.intersection_id}
                      title="Show the 24-hour forecast for this junction"
                      className={`text-left hover:text-signal-amber ${
                        forecastFor === r.intersection_id ? "text-signal-amber" : ""
                      }`}
                    >
                      {r.intersection_name}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-right">{r.vehicle_count}</td>
                  <td className="px-3 py-2 text-right">{r.avg_speed_kmh}</td>
                  <td className="px-3 py-2 text-right">{r.queue_length_m}</td>
                  <td className="px-3 py-2 text-right">{r.lane_occupancy_pct}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="blueprint-frame border hairline rounded-lg p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div className="font-mono text-[10px] text-blueprint-line/60">
            M4 — CONGESTION FORECAST, NEXT 24 HOURS
          </div>
          <select
            aria-label="Junction to forecast"
            value={forecastFor ?? ""}
            onChange={(e) => setForecastFor(Number(e.target.value))}
            className="max-w-full bg-blueprint-800 border hairline px-2 py-1.5 text-xs font-mono text-paper focus:outline-none focus:border-signal-amber"
          >
            {readings.map((r) => (
              <option key={r.intersection_id} value={r.intersection_id}>{r.intersection_name}</option>
            ))}
          </select>
        </div>
        {forecastError ? (
          <ErrorBanner message={forecastError} />
        ) : forecast ? (
          <TrendChart
            labels={forecast.forecast.map((p) => hourLabel(p.ts))}
            series={[
              { label: "Forecast", color: "#F2A65A", values: forecast.forecast.map((p) => p.predicted_congestion_score) },
              { label: "Upper band", color: "#8FD9E8", values: forecast.forecast.map((p) => p.confidence_high), fill: false },
              { label: "Lower band", color: "#6FBF8B", values: forecast.forecast.map((p) => p.confidence_low), fill: false },
            ]}
          />
        ) : (
          <div className="text-xs text-paper/40 font-mono py-12 text-center">Forecasting…</div>
        )}
        <p className="font-mono text-[10px] text-blueprint-line/40 mt-3 leading-relaxed">
          Seasonal baseline: each hour is predicted as the average of the same hour over the
          last 14 days of recorded readings, with a ±12-point band.
          {forecast?.basis === "typical_pattern" &&
            " No readings are stored for this junction yet, so a typical weekday profile is used."}
        </p>
      </section>
    </div>
  );
}
