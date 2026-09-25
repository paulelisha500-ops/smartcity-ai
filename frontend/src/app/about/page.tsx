"use client";

import Image from "next/image";
import Link from "next/link";
import PublicNav from "@/components/PublicNav";
import Reveal from "@/components/Reveal";
import { SectionHead, PublicFooter } from "@/components/PublicChrome";
import { EMIRATES } from "@/lib/emirates";

const REAL = [
  {
    title: "The road network is real",
    body: "Every motorway, trunk and primary road in the country is pulled from OpenStreetMap and stored as true PostGIS geometry. Routing runs A* over that geometry, costed by travel time rather than distance, so congestion changes the answer.",
  },
  {
    title: "The camera layer is a real client",
    body: "RTSP is spoken over a raw socket — a genuine OPTIONS/DESCRIBE handshake with Basic and Digest authentication, parsing the camera's own SDP for codec and resolution. ONVIF Profile S is spoken over SOAP with WS-Security. No stubbed responses.",
  },
  {
    title: "The project register is sourced",
    body: "Bridge and corridor figures — capacity, cost, schedule — each carry a link to the published source, because the first question in any government review is where the number came from.",
  },
  {
    title: "Corridor design checks itself",
    body: "Before proposing a new route it measures what drivers face today, finds the physical gap, and cross-references works already funded — so it never recommends something an authority is halfway through building.",
  },
];

const STACK = [
  ["Backend", "FastAPI · SQLAlchemy · GeoAlchemy2 · Celery"],
  ["Data", "PostgreSQL + PostGIS · Redis"],
  ["Frontend", "Next.js · TypeScript · Tailwind · Leaflet · Chart.js"],
  ["Geospatial", "OpenStreetMap via Overpass · A* travel-time routing"],
  ["Cameras", "RTSP (RFC 2326) · ONVIF Profile S"],
  ["Deployment", "Docker Compose"],
];

export default function AboutPage() {
  return (
    <div className="min-h-screen bg-blueprint-950">
      <PublicNav />

      <section className="relative border-b hairline overflow-hidden">
        <div className="absolute inset-0">
          <Image src="/emirates/sharjah.jpg" alt="Sharjah corniche" fill className="object-cover" />
          <div className="absolute inset-0 bg-gradient-to-r from-blueprint-950 via-blueprint-950/90 to-blueprint-950/45" />
          <div className="absolute inset-0 grid-bg opacity-50" />
        </div>
        <div className="relative max-w-6xl mx-auto px-6 pt-36 pb-24">
          <h1 className="animate-fade-up font-display text-display-sm md:text-display-md text-gradient max-w-2xl">
            About the platform
          </h1>
          <p
            className="animate-fade-up text-paper/60 mt-6 max-w-xl leading-relaxed"
            style={{ animationDelay: "120ms" }}
          >
            SmartCity AI is an urban planning and traffic management platform built for UAE
            municipalities — twelve modules covering the full loop from a camera on a
            junction to a costed proposal for a new corridor.
          </p>
        </div>
      </section>

      <section className="max-w-6xl mx-auto px-6 py-20">
        <SectionHead
          eyebrow="Approach"
          title="Built to be checked, not just demonstrated"
          lede="A planning tool is only useful if an analyst can verify what it tells them. That constraint shaped the whole system."
        />
        <div className="grid md:grid-cols-2 gap-4 mt-12">
          {REAL.map((r, i) => (
            <Reveal key={r.title} delay={i * 80}>
              <div className="card-lift h-full rounded-lg border hairline p-7 bg-blueprint-900/25">
                <h3 className="font-display text-xl text-paper">{r.title}</h3>
                <p className="text-sm text-paper/55 mt-3.5 leading-relaxed">{r.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      <section className="border-t hairline bg-blueprint-900/40">
        <div className="max-w-6xl mx-auto px-6 py-20">
          <SectionHead
            eyebrow="Capabilities"
            title="Live today, and next on the roadmap"
            lede="The platform ships with the geospatial, routing and integration layers running on real data. The perception models are the next stage."
          />
          <div className="grid md:grid-cols-2 gap-6 mt-10">
            <div className="border border-signal-green/30 bg-signal-green/5 rounded-lg p-6">
              <div className="font-mono text-[10px] text-signal-green uppercase tracking-wide">
                Live on real data
              </div>
              <ul className="mt-4 space-y-2 text-sm text-paper/70">
                {["UAE road network and geometry", "Travel-time routing and dispatch",
                  "Border crossings and cross-border corridors", "RTSP / ONVIF camera integration",
                  "Complaint classification and routing", "Infrastructure project register",
                  "Corridor feasibility analysis", "KPI analytics"].map((x) => (
                  <li key={x} className="flex gap-2"><span className="text-signal-green">▸</span>{x}</li>
                ))}
              </ul>
            </div>
            <div className="border border-signal-amber/30 bg-signal-amber/5 rounded-lg p-6">
              <div className="font-mono text-[10px] text-signal-amber uppercase tracking-wide">
                Next: perception models
              </div>
              <ul className="mt-4 space-y-2 text-sm text-paper/70">
                {["Vehicle counting from live camera streams (YOLO + ByteTrack)",
                  "Road damage detection from drone and dashcam imagery",
                  "LLM synthesis over the existing grounded retrieval layer",
                  ].map((x) => (
                  <li key={x} className="flex gap-2"><span className="text-signal-amber">▸</span>{x}</li>
                ))}
              </ul>
              <p className="text-xs text-paper/45 mt-4 leading-relaxed">
                Each sits behind a typed interface with a single method to implement, so
                deploying a trained model on GPU workers changes nothing above it.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="max-w-6xl mx-auto px-6 py-20">
        <SectionHead eyebrow="Stack" title="How it is built" />
        <div className="mt-10 border hairline divide-y divide-blueprint-line/10">
          {STACK.map(([k, v]) => (
            <div key={k} className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-6 px-5 py-4">
              <div className="font-mono text-[10px] text-blueprint-line/60 uppercase tracking-wide w-28 shrink-0">
                {k}
              </div>
              <div className="text-sm text-paper/75 font-mono">{v}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="border-t hairline">
        <div className="max-w-6xl mx-auto px-6 py-16">
          <SectionHead eyebrow="Coverage" title="Modelled nationwide" />
          <div className="flex flex-wrap gap-2 mt-8">
            {EMIRATES.map((e) => (
              <span key={e.slug} className="border hairline px-3 py-1.5 font-mono text-[11px] text-paper/70">
                {e.name}
              </span>
            ))}
          </div>
          <div className="mt-10">
            <Link href="/login" className="px-6 py-3 font-mono text-sm bg-signal-amber text-blueprint-950 hover:bg-signal-amber/90 transition-colors">
              OPEN THE CONSOLE
            </Link>
          </div>
        </div>
      </section>

      <PublicFooter />
    </div>
  );
}
