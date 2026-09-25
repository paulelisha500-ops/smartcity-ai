"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { api, describeError, CameraRow, CameraSummary, CameraTestResult } from "@/lib/api";
import { useLiveSocket } from "@/lib/live";
import KPICard from "@/components/KPICard";

const MapView = dynamic(() => import("@/components/MapView"), { ssr: false });

const STATUS_TONE: Record<string, string> = {
  online: "text-signal-green",
  offline: "text-signal-red",
  unauthorized: "text-signal-amber",
  forbidden: "text-signal-amber",
  unknown: "text-paper/40",
};

export default function CamerasPage() {
  const [cameras, setCameras] = useState<CameraRow[]>([]);
  const [summary, setSummary] = useState<CameraSummary | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<number, CameraTestResult>>({});
  const [guideOpen, setGuideOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [rows, s] = await Promise.all([api.cameras(), api.cameraSummary()]);
      setCameras(rows);
      setSummary(s);
      setError(null);
    } catch (e) {
      setError(describeError(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Fleet status updates as they happen — from the 10-minute scheduled sweep,
  // another operator's manual test, or this session's own actions — rather
  // than only reflecting what was true when the page last loaded.
  useLiveSocket(useCallback((event) => {
    if (event.type !== "camera_status") return;
    setCameras((prev) =>
      prev.map((c) => (c.id === event.camera_id ? { ...c, status: event.status } : c))
    );
  }, []));

  async function seed() {
    setBusy("seed");
    try {
      await api.seedCameraSites();
      await load();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  }

  async function sweep() {
    setBusy("sweep");
    try {
      await api.healthSweep();
      await load();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  }

  async function test(id: number) {
    setBusy(`test-${id}`);
    try {
      const r = await api.testCamera(id);
      setResults((prev) => ({ ...prev, [id]: r }));
      await load();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="p-6 space-y-6">
      <header className="flex items-end justify-between border-b hairline pb-4">
        <div>
          <h1 className="font-display text-2xl text-paper">CCTV Camera Network</h1>
          <p className="font-mono text-[11px] text-blueprint-line/60 mt-1">
            M9 — RTSP / ONVIF integration · live health · authorisation control
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={seed}
            disabled={busy !== null}
            className="border hairline px-3 py-1.5 font-mono text-[11px] text-paper/80 hover:border-signal-amber hover:text-paper disabled:opacity-40"
          >
            {busy === "seed" ? "…" : "ADD SITES"}
          </button>
          <button
            onClick={sweep}
            disabled={busy !== null}
            className="border hairline px-3 py-1.5 font-mono text-[11px] bg-signal-amber/80 text-blueprint-950 hover:bg-signal-amber disabled:opacity-40"
          >
            {busy === "sweep" ? "PROBING…" : "HEALTH SWEEP"}
          </button>
        </div>
      </header>

      {error && (
        <div role="alert" className="border border-signal-red/40 bg-signal-red/10 text-signal-red text-xs font-mono px-4 py-3">
          {error}
        </div>
      )}

      <section className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <KPICard code="M9.1" label="Cameras" value={summary?.total ?? "—"} />
        <KPICard code="M9.2" label="Authorised" value={summary?.authorized ?? "—"} tone="good" />
        <KPICard code="M9.3" label="Online" value={summary?.online ?? "—"} tone="good" />
        <KPICard
          code="M9.4"
          label="Availability"
          value={summary?.availability_pct ?? "—"}
          unit="%"
          tone={summary && summary.availability_pct < 90 ? "warn" : "good"}
        />
        <KPICard code="M9.5" label="Avg latency" value={summary?.avg_latency_ms ?? "—"} unit="ms" />
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <div className="lg:col-span-2 blueprint-frame border hairline h-[55vh] min-h-[300px] lg:h-[420px] overflow-hidden">
          <MapView cameras={cameras} center={[25.0, 55.3]} zoom={8} />
        </div>

        <div className="lg:col-span-3 blueprint-frame border hairline overflow-x-auto">
          <div className="max-h-[420px] overflow-y-auto">
            <table className="w-full text-xs font-mono">
              <thead className="sticky top-0">
                <tr className="bg-blueprint-800 text-paper/60 uppercase text-[10px]">
                  <th className="text-left px-3 py-2">Camera</th>
                  <th className="text-left px-3 py-2">Proto</th>
                  <th className="text-left px-3 py-2">Status</th>
                  <th className="text-right px-3 py-2">Latency</th>
                  <th className="text-right px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {cameras.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-10 text-center text-paper/40">
                      No cameras registered. Click ADD SITES to create camera positions
                      at the monitored junctions.
                    </td>
                  </tr>
                )}
                {cameras.map((c) => (
                  <tr key={c.id} className="border-t hairline align-top">
                    <td className="px-3 py-2">
                      <div className="text-paper/90">{c.name}</div>
                      <div className="text-[10px] text-paper/40">
                        {c.emirate} {c.road_ref && `· ${c.road_ref}`} · {c.host}
                        {c.port ? `:${c.port}` : ""}
                      </div>
                      {results[c.id]?.error && (
                        <div className="text-[10px] text-signal-red mt-1">
                          {results[c.id].error}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 uppercase">{c.protocol}</td>
                    <td className={`px-3 py-2 ${STATUS_TONE[c.status] ?? "text-paper/50"}`}>
                      {c.status}
                      {!c.authorized && (
                        <div className="text-[10px] text-paper/35">no permit</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {c.latency_ms ? `${c.latency_ms} ms` : "—"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => test(c.id)}
                        disabled={busy !== null}
                        className="border hairline px-2 py-1 text-[10px] hover:border-signal-amber disabled:opacity-40"
                      >
                        {busy === `test-${c.id}` ? "…" : "TEST"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="blueprint-frame border hairline">
        <button
          onClick={() => setGuideOpen((v) => !v)}
          className="w-full text-left px-4 py-3 font-mono text-[11px] text-blueprint-line/70 hover:text-paper"
        >
          {guideOpen ? "▾" : "▸"} CONNECTING REAL CAMERAS — WHAT YOU NEED
        </button>
        {guideOpen && (
          <div className="px-4 pb-4 text-xs text-paper/70 space-y-3 font-mono leading-relaxed">
            <div>
              <span className="text-signal-amber">1. Authorisation.</span> The platform
              refuses to contact a camera unless its record is marked authorised. Dubai
              traffic CCTV is operated by the <span className="text-paper">RTA</span>; live
              feed access needs a data-sharing agreement with them. Abu Dhabi cameras sit
              with the DMT / Integrated Transport Centre. Private cameras (malls, yards,
              campuses) need the site owner&apos;s written permission. Record the agreement
              reference on the camera so it is auditable.
            </div>
            <div>
              <span className="text-signal-amber">2. Credentials.</span> Passwords are never
              stored in the database. Put the password in an environment variable on the
              backend and set the camera&apos;s <code>credential_ref</code> to that variable&apos;s
              name.
            </div>
            <div>
              <span className="text-signal-amber">3. Connection.</span> For ONVIF cameras you
              only need the IP — <code>POST /api/cameras/onboard</code> reads the make,
              model, firmware and the exact stream and snapshot URIs off the device. For
              RTSP give host, port (554) and the stream path.
            </div>
            <div>
              <span className="text-signal-amber">4. Analytics stream.</span> Register a
              sub-stream path. Vehicle detection runs on the low-resolution sub-stream —
              a car is just as detectable at 640×480, and decoding 4MP per camera is what
              makes city-scale CV fall over.
            </div>
            <div>
              <span className="text-signal-amber">5. Open data today.</span> Without a camera
              agreement you can still pull real Dubai government traffic data from{" "}
              <span className="text-paper">Dubai Pulse</span> (dubaipulse.gov.ae) — set{" "}
              <code>SMARTCITY_DUBAI_PULSE_KEY</code> and <code>_SECRET</code>.
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
