"use client";

import Link from "next/link";
import { useState } from "react";
import PublicNav from "@/components/PublicNav";
import { SectionHead, PublicFooter } from "@/components/PublicChrome";

interface QA { q: string; a: React.ReactNode; }

const SECTIONS: { group: string; items: QA[] }[] = [
  {
    group: "Getting started",
    items: [
      {
        q: "How do I sign in?",
        a: (
          <>
            Pick a role on the{" "}
            <Link href="/login" className="text-signal-amber hover:underline">sign-in page</Link> —
            administrator, traffic officer, city planner, maintenance or public user. The
            role travels in the token as a claim, and the API enforces it on every request,
            so what a user can see and change is decided server-side rather than by hiding
            buttons in the interface.
          </>
        ),
      },
      {
        q: "The dashboard is empty. What do I do?",
        a: (
          <>
            The platform starts with no data loaded. Three one-click actions fill it:
            <strong className="text-paper"> UAE Road Network → INGEST NETWORK</strong> (downloads
            the real road geometry, 1–5 minutes),
            <strong className="text-paper"> Bridges &amp; Projects → LOAD REGISTER</strong>, and
            <strong className="text-paper"> CCTV Network → ADD SITES</strong>. Routing and
            corridor design depend on the first one.
          </>
        ),
      },
      {
        q: "Why does the network ingest take minutes?",
        a: (
          <>
            It downloads live data from the public OpenStreetMap Overpass API, which is a
            shared free service under constant load. The ingest tiles the country into
            small requests, fails over between mirrors, and saves each tile as it arrives —
            so progress is visible and one slow tile never loses the whole run.
          </>
        ),
      },
    ],
  },
  {
    group: "Cameras and CCTV",
    items: [
      {
        q: "Can this connect to Dubai's traffic cameras?",
        a: (
          <>
            Technically yes — the integration is real and speaks RTSP and ONVIF. But access
            is not ours to grant. Traffic CCTV in Dubai is operated by the{" "}
            <strong className="text-paper">Roads &amp; Transport Authority (RTA)</strong>, and in
            Abu Dhabi by the Department of Municipalities and Transport. Connecting to a live
            feed requires a data-sharing agreement and credentials issued by that authority.
            Once you have them, you enter the host and credential reference and the camera
            works like any other.
          </>
        ),
      },
      {
        q: "Why won't the platform contact a camera I added?",
        a: (
          <>
            Because it is not marked authorised. The connector refuses to open a connection
            to any camera without an authorisation record — a deliberate guard so nobody can
            point the platform at devices they have no right to access. Set{" "}
            <code className="font-mono text-paper">authorized</code> and record the agreement
            reference, and it will connect.
          </>
        ),
      },
      {
        q: "Where are camera passwords stored?",
        a: (
          <>
            Nowhere in the database. A camera record holds a{" "}
            <code className="font-mono text-paper">credential_ref</code> — the <em>name</em> of an
            environment variable or secret-store entry — and the connector resolves the actual
            secret at call time. The database can be dumped or shared without leaking camera
            credentials.
          </>
        ),
      },
      {
        q: "Is there real Dubai traffic data without a camera agreement?",
        a: (
          <>
            Yes. <strong className="text-paper">Dubai Pulse</strong> (dubaipulse.gov.ae) publishes
            government open data including traffic incidents, under OAuth client credentials.
            Set the key and secret in the backend environment and the connector will use it.
          </>
        ),
      },
    ],
  },
  {
    group: "Planning and routing",
    items: [
      {
        q: "Are the bridge and project figures real?",
        a: (
          <>
            Yes, and every one carries a link to its published source — the Dubai Islands
            bridge, the Al Shindagha corridor, the Al Reem Island marine bridges and the rest.
            Where a cost has not been published, the field is left empty rather than estimated,
            and the portfolio total says so.
          </>
        ),
      },
      {
        q: "How reliable are the corridor cost estimates?",
        a: (
          <>
            They are option-screening figures, not engineering estimates. Costs come from
            published UAE unit rates (roughly AED 30m per km at grade up to AED 520m per km
            tunnelled) applied to a straight-line alignment. They are good enough to rank
            options and wrong enough that nobody should budget from them.
          </>
        ),
      },
      {
        q: 'Why does routing sometimes say "no route found"?',
        a: (
          <>
            Almost always because the network in that area is incomplete — if the slip roads
            were not ingested, carriageways exist but nothing joins them. The{" "}
            <code className="font-mono text-paper">/api/network/graph</code> endpoint reports the
            size of the largest connected component; if it is low, re-ingest including the
            link road classes for that region.
          </>
        ),
      },
      {
        q: "Does emergency dispatch really route on the road network?",
        a: (
          <>
            Yes — each candidate hospital or station is routed over the real geometry and
            ranked by drive time, because nearest by straight line is often not fastest when a
            creek or a closed interchange sits in between. Emergency times apply a 0.75
            blue-light factor to the civilian travel time.
          </>
        ),
      },
    ],
  },
  {
    group: "Data and governance",
    items: [
      {
        q: "Where does the map data come from?",
        a: (
          <>
            OpenStreetMap, via the Overpass API, © OpenStreetMap contributors under the Open
            Database Licence. Basemap tiles are from Esri. Emirate photography is from
            Wikimedia Commons under CC BY / CC BY-SA licences, credited on the home page.
          </>
        ),
      },
      {
        q: "Is any personal data processed?",
        a: (
          <>
            No. Citizen complaints are free text with an optional location and
            carry no identity beyond an opaque reporter reference. There is no facial
            recognition, no vehicle-plate recognition and no person tracking anywhere in the
            platform — the computer vision interface is scoped to vehicle counts and road
            surface condition.
          </>
        ),
      },
    ],
  },
];

export default function FAQPage() {
  const [open, setOpen] = useState<string | null>("How do I sign in?");
  return (
    <div className="min-h-screen bg-blueprint-950">
      <PublicNav />

      <section className="relative border-b hairline overflow-hidden">
        <div className="absolute inset-0 grid-bg opacity-60" />
        <div className="relative max-w-4xl mx-auto px-6 pt-36 pb-20">
          <h1 className="animate-fade-up font-display text-display-sm md:text-display-md text-gradient">
            Frequently asked questions
          </h1>
          <p
            className="animate-fade-up text-paper/55 mt-5 max-w-xl leading-relaxed"
            style={{ animationDelay: "120ms" }}
          >
            What the platform does, what it needs from you, and where its limits are.
          </p>
        </div>
      </section>

      <div className="max-w-4xl mx-auto px-6 py-16 space-y-14">
        {SECTIONS.map((section) => (
          <section key={section.group}>
            <SectionHead eyebrow="FAQ" title={section.group} />
            <div className="mt-7 rounded-lg border hairline divide-y divide-blueprint-line/10 overflow-hidden">
              {section.items.map((item, idx) => {
                const uid = `faq-${section.group.replace(/\W/g, "")}-${idx}`;
                const isOpen = open === item.q;
                return (
                  <div key={item.q} className={isOpen ? "bg-blueprint-900/30" : ""}>
                    <button
                      onClick={() => setOpen(isOpen ? null : item.q)}
                      aria-expanded={isOpen}
                      aria-controls={`${uid}`}
                      id={`${uid}-btn`}
                      className="group w-full flex items-start justify-between gap-4 px-5 py-4 text-left hover:bg-blueprint-800/30 transition-colors duration-300"
                    >
                      <span className="text-[15px] text-paper/85 group-hover:text-paper transition-colors">
                        {item.q}
                      </span>
                      <span
                        className={`font-mono text-signal-amber shrink-0 mt-0.5 transition-transform duration-400 ease-out-expo ${
                          isOpen ? "rotate-45" : ""
                        }`}
                      >
                        +
                      </span>
                    </button>
                    {/* Grid-rows trick: animates height without needing a fixed
                        pixel value for content of unknown length. */}
                    <div
                      className="grid transition-all duration-500 ease-out-expo"
                      style={{ gridTemplateRows: isOpen ? "1fr" : "0fr" }}
                    >
                      <div className="overflow-hidden">
                        <div className="px-5 pb-5 text-sm text-paper/60 leading-relaxed max-w-2xl">
                          {item.a}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))}

        <div className="border hairline p-6 text-center">
          <p className="text-sm text-paper/70">Still have a question about the platform?</p>
          <Link
            href="/login"
            className="inline-block mt-4 px-6 py-2.5 font-mono text-sm bg-signal-amber text-blueprint-950 hover:bg-signal-amber/90 transition-colors"
          >
            EXPLORE THE CONSOLE
          </Link>
        </div>
      </div>

      <PublicFooter />
    </div>
  );
}
