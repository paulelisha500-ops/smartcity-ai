"use client";

import { useEffect, useState } from "react";
import { api, describeError, KPIs, CongestionHistoryPoint, ComplaintHistoryPoint } from "@/lib/api";
import ErrorBanner from "@/components/ErrorBanner";
import KPICard from "@/components/KPICard";
import TrendChart from "@/components/TrendChart";

const RANGE_OPTIONS = [
  { label: "24H", hours: 24 },
  { label: "3D", hours: 24 * 3 },
  { label: "7D", hours: 24 * 7 },
];

function hourLabel(iso: string, spanHours: number) {
  const d = new Date(iso);
  // Past a few days the hour alone is ambiguous (which day?), so widen the
  // label rather than let two ticks read identically on the x-axis.
  return spanHours > 24 * 2
    ? d.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit" })
    : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function dayLabel(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function AnalyticsPage() {
  const [kpis, setKpis] = useState<KPIs | null>(null);
  const [congestion, setCongestion] = useState<CongestionHistoryPoint[]>([]);
  const [complaints, setComplaints] = useState<ComplaintHistoryPoint[]>([]);
  const [rangeHours, setRangeHours] = useState(24);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.kpis().then(setKpis).catch((e) => setError(describeError(e)));
    api.complaintHistory(30).then(setComplaints).catch((e) => setError(describeError(e)));
  }, []);

  useEffect(() => {
    setLoading(true);
    api.congestionHistory(rangeHours)
      .then(setCongestion)
      .catch((e) => { setCongestion([]); setError(describeError(e)); })
      .finally(() => setLoading(false));
  }, [rangeHours]);

  const congestionEmpty = !loading && congestion.length === 0;

  return (
    <div className="p-6 space-y-6">
      <header className="border-b hairline pb-4">
        <h1 className="font-display text-2xl text-paper">Government Analytics</h1>
        <p className="font-mono text-[11px] text-blueprint-line/60 mt-1">
          M8 — the KPI set a city agency reports on monthly, with trend history
        </p>
      </header>

      <ErrorBanner message={error} />

      <section className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <KPICard code="M8.1" label="Congestion index" value={kpis?.congestion_index ?? "—"} unit="/100" tone={kpis && kpis.congestion_index > 65 ? "bad" : "default"} />
        <KPICard code="M8.2" label="Avg speed" value={kpis?.avg_speed_kmh ?? "—"} unit="km/h" />
        <KPICard code="M8.3" label="Road quality" value={kpis?.road_quality_score ?? "—"} unit="/100" tone={kpis && kpis.road_quality_score < 60 ? "warn" : "good"} />
        <KPICard code="M8.4" label="Complaints" value={kpis?.complaint_count ?? "—"} />
        <KPICard code="M8.5" label="Resolution rate" value={kpis?.complaint_resolution_rate_pct ?? "—"} unit="%" tone="good" />
        <KPICard code="M8.6" label="Satisfaction" value={kpis?.public_satisfaction_proxy_pct ?? "—"} unit="%" tone="good" />
      </section>

      <section className="blueprint-frame border hairline rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="font-mono text-[10px] text-blueprint-line/60">
            CONGESTION &amp; SPEED TREND
          </div>
          <div className="flex gap-1.5">
            {RANGE_OPTIONS.map((r) => (
              <button
                key={r.label}
                onClick={() => setRangeHours(r.hours)}
                className={`px-2.5 py-1 font-mono text-[10px] rounded border transition-colors ${
                  rangeHours === r.hours
                    ? "border-signal-amber text-signal-amber"
                    : "border-blueprint-line/20 text-paper/50 hover:text-paper"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {congestionEmpty ? (
          <div className="text-xs text-paper/40 font-mono py-16 text-center">
            No history yet — the snapshot task records readings every 15 minutes, so
            trends fill in as the platform stays up.
          </div>
        ) : (
          <TrendChart
            labels={congestion.map((p) => hourLabel(p.hour, rangeHours))}
            series={[
              {
                label: "Congestion score",
                color: "#F2A65A",
                values: congestion.map((p) => p.avg_congestion_score),
              },
              {
                label: "Avg speed (km/h)",
                color: "#8FD9E8",
                values: congestion.map((p) => p.avg_speed_kmh),
                rightAxis: true,
              },
            ]}
          />
        )}
      </section>

      <section className="blueprint-frame border hairline rounded-lg p-4">
        <div className="font-mono text-[10px] text-blueprint-line/60 mb-3">
          COMPLAINT VOLUME — LAST 30 DAYS
        </div>
        {complaints.length === 0 ? (
          <div className="text-xs text-paper/40 font-mono py-16 text-center">
            No complaints recorded in this window yet.
          </div>
        ) : (
          <TrendChart
            labels={complaints.map((p) => dayLabel(p.day))}
            series={[
              { label: "Total", color: "#8FD9E8", values: complaints.map((p) => p.total) },
              { label: "High priority", color: "#E2694F", values: complaints.map((p) => p.high_priority) },
              { label: "Resolved", color: "#6FBF8B", values: complaints.map((p) => p.resolved) },
            ]}
          />
        )}
      </section>

      <p className="font-mono text-[10px] text-blueprint-line/40">
        Congestion history is recorded from the live traffic model every 15 minutes;
        complaint history is derived directly from submission timestamps — both are
        aggregate counts only, with no individual complaint text exposed.
      </p>
    </div>
  );
}
