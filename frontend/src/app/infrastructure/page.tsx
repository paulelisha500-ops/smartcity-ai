"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { api, describeError, Project, ProjectSummary } from "@/lib/api";
import ErrorBanner from "@/components/ErrorBanner";
import KPICard from "@/components/KPICard";

const MapView = dynamic(() => import("@/components/MapView"), { ssr: false });

const STATUS_TONE: Record<string, string> = {
  completed: "text-signal-green",
  under_construction: "text-signal-amber",
  planned: "text-blueprint-line",
};

const FILTERS = ["all", "under_construction", "completed", "planned"];

export default function InfrastructurePage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [summary, setSummary] = useState<ProjectSummary | null>(null);
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, s] = await Promise.all([api.projects(), api.projectSummary()]);
      setProjects(p);
      setSummary(s);
      setError(null);
    } catch (e) {
      setError(describeError(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function seed() {
    setBusy(true);
    try {
      await api.seedProjects();
      await load();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const shown = filter === "all" ? projects : projects.filter((p) => p.status === filter);

  return (
    <div className="p-6 space-y-6">
      <header className="flex items-end justify-between border-b hairline pb-4">
        <div>
          <h1 className="font-display text-2xl text-paper">Bridges &amp; Infrastructure Projects</h1>
          <p className="font-mono text-[11px] text-blueprint-line/60 mt-1">
            M11 — UAE capital works register · every figure carries a published source
          </p>
        </div>
        <button
          onClick={seed}
          disabled={busy}
          className="border hairline px-3 py-1.5 font-mono text-[11px] bg-signal-amber/80 text-blueprint-950 hover:bg-signal-amber disabled:opacity-40"
        >
          {busy ? "LOADING…" : "LOAD REGISTER"}
        </button>
      </header>

      <ErrorBanner message={error} onRetry={load} />

      <section className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <KPICard code="M11.1" label="Projects" value={summary?.total_projects ?? "—"} />
        <KPICard
          code="M11.2"
          label="Under construction"
          value={summary?.by_status?.under_construction ?? "—"}
          tone="warn"
        />
        <KPICard
          code="M11.3"
          label="Completed"
          value={summary?.by_status?.completed ?? "—"}
          tone="good"
        />
        <KPICard
          code="M11.4"
          label="Capacity added"
          value={summary?.capacity_added_vph?.toLocaleString() ?? "—"}
          unit="v/h"
          tone="good"
        />
        <KPICard
          code="M11.5"
          label="Known spend"
          value={summary?.known_cost_aed_m ?? "—"}
          unit="M AED"
        />
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <div className="lg:col-span-2 blueprint-frame border hairline h-[55vh] min-h-[300px] lg:h-[460px] overflow-hidden">
          <MapView projects={projects} center={[24.9, 55.0]} zoom={8} />
        </div>

        <div className="lg:col-span-3 space-y-3">
          <div className="flex gap-2">
            {FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`border hairline px-3 py-1 font-mono text-[10px] uppercase ${
                  filter === f
                    ? "border-signal-amber text-paper bg-blueprint-800/60"
                    : "text-paper/60 hover:text-paper"
                }`}
              >
                {f.replace("_", " ")}
              </button>
            ))}
          </div>

          <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1">
            {shown.length === 0 && (
              <div className="blueprint-frame border hairline p-8 text-center font-mono text-xs text-paper/40">
                No projects loaded. Click LOAD REGISTER.
              </div>
            )}
            {shown.map((p) => (
              <div key={p.id} className="blueprint-frame border hairline p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm text-paper/90">{p.name}</div>
                    <div className="font-mono text-[10px] text-paper/45 mt-0.5">
                      {p.project_type.replace("_", " ")} · {p.authority ?? "—"} · {p.emirate ?? "—"}
                    </div>
                  </div>
                  <span
                    className={`font-mono text-[10px] uppercase shrink-0 ${
                      STATUS_TONE[p.status] ?? "text-paper/50"
                    }`}
                  >
                    {p.status.replace("_", " ")}
                  </span>
                </div>

                {p.description && (
                  <p className="text-xs text-paper/60 mt-2 leading-relaxed">{p.description}</p>
                )}

                <div className="flex flex-wrap gap-x-5 gap-y-1 mt-3 font-mono text-[10px] text-paper/55">
                  {p.length_m && <span>LENGTH {p.length_m.toLocaleString()} m</span>}
                  {p.lanes && <span>LANES {p.lanes}</span>}
                  {p.capacity_vph && <span>CAPACITY {p.capacity_vph.toLocaleString()} v/h</span>}
                  {p.cost_aed_m && <span>COST AED {p.cost_aed_m}m</span>}
                  {p.travel_time_saving_pct && (
                    <span className="text-signal-green">
                      −{p.travel_time_saving_pct}% TRAVEL TIME
                    </span>
                  )}
                  {p.completion_year && <span>TARGET {p.completion_year}</span>}
                </div>

                {p.source_url && (
                  <a
                    href={p.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block mt-2 font-mono text-[10px] text-signal-amber/80 hover:text-signal-amber underline underline-offset-2"
                  >
                    source ↗
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
