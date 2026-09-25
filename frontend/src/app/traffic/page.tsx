"use client";

import { useEffect, useState } from "react";
import { api, describeError, TrafficReading, Hotspot } from "@/lib/api";
import ErrorBanner from "@/components/ErrorBanner";
import CongestionChart from "@/components/CongestionChart";

export default function TrafficPage() {
  const [readings, setReadings] = useState<TrafficReading[]>([]);
  const [hotspots, setHotspots] = useState<Hotspot[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.liveTraffic().then(setReadings).catch((e) => setError(describeError(e)));
    api.hotspots(8).then(setHotspots).catch((e) => setError(describeError(e)));
  }, []);

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
                  <td className="px-3 py-2">{r.intersection_name}</td>
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
    </div>
  );
}
