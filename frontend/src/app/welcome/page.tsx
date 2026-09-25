"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useState } from "react";
import PublicNav from "@/components/PublicNav";
import BrandMark from "@/components/BrandMark";
import { SectionHead, PublicFooter } from "@/components/PublicChrome";
import Reveal from "@/components/Reveal";
import { EMIRATES, CREDIT_NOTE } from "@/lib/emirates";
import { api } from "@/lib/api";

const MODULES = [
  { n: "01", name: "Smart Traffic Analysis", desc: "Vehicle counts, speed and congestion scoring per junction." },
  { n: "02", name: "Road Damage Detection", desc: "Potholes, cracks and waterlogging ranked for the repair queue." },
  { n: "03", name: "Citizen Complaints", desc: "Free-text reports classified, prioritised and routed automatically." },
  { n: "04", name: "Traffic Prediction", desc: "Hour-ahead congestion forecasts and event-impact estimates." },
  { n: "05", name: "AI City Planner", desc: "Grounded answers over live city data, with every source cited." },
  { n: "06", name: "Digital Twin", desc: "One live map of traffic, damage, cameras and works in progress." },
  { n: "07", name: "Emergency Dispatch", desc: "Fastest-response routing on the real network, not straight lines." },
  { n: "08", name: "Government Analytics", desc: "The KPI set a city agency reports on monthly." },
  { n: "09", name: "CCTV Network", desc: "RTSP and ONVIF camera integration with authorisation control." },
  { n: "10", name: "UAE Road Network", desc: "Real road geometry for all seven emirates and both frontiers." },
  { n: "11", name: "Bridges & Projects", desc: "The national capital-works register, every figure sourced." },
  { n: "12", name: "New Route Design", desc: "Corridor feasibility, costed against what is already funded." },
];

const PROOF = [
  {
    k: "Real geometry",
    t: "Routing on the roads that exist",
    d: "A* over true OpenStreetMap geometry, costed by travel time so congestion changes the answer — not a demo graph.",
  },
  {
    k: "Real protocols",
    t: "Cameras, spoken natively",
    d: "RTSP handshakes and ONVIF SOAP implemented at the wire level — real device discovery, real authentication.",
  },
  {
    k: "Real provenance",
    t: "Every figure has a source",
    d: "Capacity, cost and schedule each link to the published record, because that is the first thing a reviewer asks for.",
  },
];

export default function WelcomePage() {
  const [stats, setStats] = useState<{ km?: number; links?: number; crossings?: number }>({});

  useEffect(() => {
    api.networkStatus()
      .then((s) => setStats({ km: s.network_km, links: s.road_links, crossings: s.border_crossings }))
      .catch(() => {});
  }, []);

  return (
    <div className="min-h-screen bg-blueprint-950 overflow-x-hidden">
      <PublicNav />

      {/* ---------------------------------------------------------- hero */}
      <section className="relative min-h-[92vh] flex items-center border-b hairline">
        <div className="absolute inset-0">
          <Image src="/emirates/dubai.jpg" alt="Dubai skyline" fill priority className="object-cover scale-105" />
          <div className="absolute inset-0 bg-gradient-to-r from-blueprint-950 via-blueprint-950/92 to-blueprint-950/35" />
          <div className="absolute inset-0 bg-gradient-to-t from-blueprint-950 via-transparent to-blueprint-950/60" />
          <div className="absolute inset-0 grid-bg opacity-60" />
        </div>

        <div className="relative w-full max-w-6xl mx-auto px-6 py-24">
          <div className="animate-fade-in flex items-center gap-2.5 mb-8">
            <span className="flex gap-1">
              <span className="h-4 w-1 rounded-sm bg-uae-red" />
              <span className="h-4 w-1 rounded-sm bg-uae-green" />
              <span className="h-4 w-1 rounded-sm bg-paper" />
              <span className="h-4 w-1 rounded-sm bg-uae-black ring-1 ring-paper/25" />
            </span>
            <span className="font-mono text-[11px] tracking-[0.22em] text-blueprint-line/80 uppercase">
              United Arab Emirates
            </span>
          </div>

          <h1
            className="animate-fade-up font-display text-display-sm md:text-display-md lg:text-display-lg text-gradient max-w-4xl"
            style={{ animationDelay: "80ms" }}
          >
            Intelligent urban planning for the seven emirates
          </h1>

          <p
            className="animate-fade-up mt-7 text-paper/65 max-w-xl text-[15px] leading-relaxed"
            style={{ animationDelay: "180ms" }}
          >
            One operations platform for traffic, citizen services, emergency response and
            long-range infrastructure planning — running on the real UAE road network, with
            live CCTV integration and corridor design that checks itself against projects
            already under construction.
          </p>

          <div className="animate-fade-up mt-10 flex flex-wrap gap-3" style={{ animationDelay: "280ms" }}>
            <Link
              href="/login"
              className="btn-primary group px-7 py-3.5 rounded-md font-mono text-[13px] tracking-wide bg-signal-amber text-blueprint-950 hover:bg-signal-amber/90 transition-all duration-300 hover:shadow-[0_8px_30px_-6px_rgba(242,166,90,0.45)]"
            >
              SIGN IN TO THE CONSOLE
              <span className="inline-block ml-2 transition-transform duration-300 group-hover:translate-x-1">→</span>
            </Link>
            <Link
              href="/about"
              className="px-7 py-3.5 rounded-md font-mono text-[13px] tracking-wide border hairline text-paper/75 hover:text-paper hover:border-blueprint-line/50 hover:bg-blueprint-800/40 transition-all duration-300"
            >
              WHAT IT DOES
            </Link>
            <Link
              href="/report"
              className="px-7 py-3.5 rounded-md font-mono text-[13px] tracking-wide text-paper/60 hover:text-paper transition-all duration-300 underline-offset-4 hover:underline"
            >
              Report a problem →
            </Link>
          </div>

          <div
            className="animate-fade-up mt-16 grid grid-cols-2 md:grid-cols-4 gap-3 max-w-3xl"
            style={{ animationDelay: "380ms" }}
          >
            <Stat label="Road network" value={stats.km ? `${Math.round(stats.km).toLocaleString()}` : "—"} unit="km" />
            <Stat label="Mapped links" value={stats.links ? stats.links.toLocaleString() : "—"} />
            <Stat label="Border crossings" value={stats.crossings ?? "—"} />
            <Stat label="Modules" value="12" />
          </div>
        </div>

        <div className="absolute bottom-7 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1.5 opacity-40">
          <span className="font-mono text-[9px] tracking-[0.25em] text-blueprint-line uppercase">Scroll</span>
          <span className="h-8 w-px bg-gradient-to-b from-blueprint-line to-transparent" />
        </div>
      </section>

      {/* --------------------------------------------------------- proof */}
      <section className="max-w-6xl mx-auto px-6 py-24">
        <div className="grid md:grid-cols-3 gap-5">
          {PROOF.map((p, i) => (
            <Reveal key={p.k} delay={i * 90}>
              <div className="card-lift h-full border hairline rounded-lg p-7 bg-blueprint-900/25">
                <div className="font-mono text-[10px] tracking-[0.18em] text-signal-amber/85 uppercase">
                  {p.k}
                </div>
                <h3 className="font-display text-xl text-paper mt-3.5">{p.t}</h3>
                <p className="text-sm text-paper/55 mt-3 leading-relaxed">{p.d}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------ emirates */}
      <section className="max-w-6xl mx-auto px-6 pb-24">
        <Reveal>
          <SectionHead
            eyebrow="Coverage"
            title="All seven emirates"
            lede="Road geometry, junctions and cross-border corridors are modelled nationwide — from the Saudi frontier at Al Ghuwaifat to the Omani crossings on the east coast."
          />
        </Reveal>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-12">
          {EMIRATES.map((e, i) => (
            <Reveal
              key={e.slug}
              delay={i * 70}
              className={i === 0 ? "sm:col-span-2 lg:col-span-2 lg:row-span-2" : ""}
            >
              <article className="group relative h-full overflow-hidden rounded-lg border hairline card-lift">
                <div className={`relative ${i === 0 ? "h-64 lg:h-[452px]" : "h-56"}`}>
                  <Image
                    src={e.image}
                    alt={e.alt}
                    fill
                    sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
                    className="object-cover transition-transform duration-[900ms] ease-out-expo group-hover:scale-[1.07]"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-blueprint-950 via-blueprint-950/35 to-transparent" />
                  <div className="absolute inset-0 bg-signal-amber/0 group-hover:bg-signal-amber/[0.06] transition-colors duration-500" />
                </div>

                <div className="absolute bottom-0 left-0 right-0 p-5">
                  <div className="flex items-baseline justify-between gap-2">
                    <h3 className={`font-display text-paper ${i === 0 ? "text-2xl" : "text-lg"}`}>
                      {e.name}
                    </h3>
                    <span className="font-mono text-[9px] text-blueprint-line/70 shrink-0">{e.code}</span>
                  </div>
                  <p className="text-[11px] text-paper/50 mt-1.5 leading-relaxed max-h-0 opacity-0 group-hover:max-h-24 group-hover:opacity-100 transition-all duration-500 ease-out-expo overflow-hidden">
                    {e.note}
                  </p>
                </div>
              </article>
            </Reveal>
          ))}
        </div>

        <Reveal>
          <p className="font-mono text-[10px] text-blueprint-line/35 mt-7 leading-relaxed">
            {CREDIT_NOTE}
          </p>
        </Reveal>
      </section>

      {/* ------------------------------------------------------- modules */}
      <section className="border-y hairline bg-blueprint-900/25">
        <div className="max-w-6xl mx-auto px-6 py-24">
          <Reveal>
            <SectionHead
              eyebrow="Platform"
              title="Twelve modules, one console"
              lede="Each module is an independent service behind a typed interface, so any one of them can be scaled, replaced or upgraded without touching the rest."
            />
          </Reveal>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mt-12">
            {MODULES.map((m, i) => (
              <Reveal key={m.n} delay={(i % 3) * 70}>
                <div className="group h-full rounded-lg border hairline p-5 bg-blueprint-950/60 card-lift">
                  <div className="flex items-center gap-2.5">
                    <span className="font-mono text-[10px] text-signal-amber/80">M{m.n}</span>
                    <span className="h-px flex-1 bg-blueprint-line/15 group-hover:bg-signal-amber/30 transition-colors duration-500" />
                  </div>
                  <div className="font-display text-[15px] text-paper mt-3">{m.name}</div>
                  <p className="text-[13px] text-paper/50 mt-2 leading-relaxed">{m.desc}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------- CTA */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 grid-bg opacity-50" />
        <div className="relative max-w-3xl mx-auto px-6 py-28 text-center">
          <Reveal>
            <h2 className="font-display text-display-sm md:text-4xl text-paper">
              Open the operations console
            </h2>
            <p className="text-paper/55 mt-4 max-w-lg mx-auto leading-relaxed">
              Role-based access for administrators, traffic officers, city planners,
              maintenance teams and public users.
            </p>
            <Link
              href="/login"
              className="btn-primary group inline-block mt-9 px-9 py-3.5 rounded-md font-mono text-[13px] tracking-wide bg-signal-amber text-blueprint-950 hover:bg-signal-amber/90 transition-all duration-300 hover:shadow-[0_8px_30px_-6px_rgba(242,166,90,0.45)]"
            >
              SIGN IN
              <span className="inline-block ml-2 transition-transform duration-300 group-hover:translate-x-1">→</span>
            </Link>
          </Reveal>
        </div>
      </section>

      <PublicFooter />
    </div>
  );
}

function Stat({ label, value, unit }: { label: string; value: string | number; unit?: string }) {
  return (
    <div className="glass rounded-lg px-4 py-4 card-lift">
      <div className="font-display text-2xl text-paper tracking-tight">
        {value}
        {unit && <span className="text-sm text-paper/45 ml-1">{unit}</span>}
      </div>
      <div className="font-mono text-[9px] text-blueprint-line/60 uppercase tracking-[0.14em] mt-1.5">
        {label}
      </div>
    </div>
  );
}
