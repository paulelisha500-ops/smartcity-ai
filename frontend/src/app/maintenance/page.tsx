"use client";

import { useEffect, useState } from "react";
import { api, describeError, RoadDamagePoint } from "@/lib/api";

const SEVERITY_TONE = (s: number) => (s >= 0.7 ? "text-signal-red" : s >= 0.4 ? "text-signal-amber" : "text-signal-green");
import ErrorBanner from "@/components/ErrorBanner";

export default function MaintenancePage() {
  const [items, setItems] = useState<RoadDamagePoint[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.roadDamagePriority(20).then(setItems).catch((e) => setError(describeError(e)));
  }, []);

  return (
    <div className="p-6 space-y-6">
      <header className="border-b hairline pb-4">
        <h1 className="font-display text-2xl text-paper">Road Maintenance Priority Queue</h1>
        <p className="font-mono text-[11px] text-blueprint-line/60 mt-1">
          M2 — detected potholes, cracks, waterlogging &amp; missing signage, ranked by severity × confidence
        </p>
      </header>

      <ErrorBanner message={error} />

      <div className="blueprint-frame border hairline overflow-x-auto">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="bg-blueprint-800/60 text-paper/60 uppercase text-[10px]">
              <th className="text-left px-3 py-2">Segment</th>
              <th className="text-left px-3 py-2">Damage type</th>
              <th className="text-right px-3 py-2">Severity</th>
              <th className="text-right px-3 py-2">Confidence</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-8 text-center text-paper/40">
                  No detections in this scan window.
                </td>
              </tr>
            )}
            {items.map((d, i) => (
              <tr key={`${d.id}-${i}`} className="border-t hairline">
                <td className="px-3 py-2">{d.name}</td>
                <td className="px-3 py-2 capitalize">{d.damage_type.replace("_", " ")}</td>
                <td className={`px-3 py-2 text-right ${SEVERITY_TONE(d.severity)}`}>
                  {(d.severity * 100).toFixed(0)}%
                </td>
                <td className="px-3 py-2 text-right">{(d.confidence * 100).toFixed(0)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
