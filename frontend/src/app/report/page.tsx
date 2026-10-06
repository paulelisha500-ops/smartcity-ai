"use client";

import Link from "next/link";
import PublicNav from "@/components/PublicNav";
import ComplaintForm from "@/components/ComplaintForm";

/**
 * The citizen-facing report flow — no login, no console chrome.
 *
 * Split out from the operations console deliberately: before this page
 * existed, submitting a complaint meant landing inside the same interface
 * used to register camera credentials and edit the infrastructure register.
 * A citizen reporting a pothole should never see that surface, and shouldn't
 * need an account to reach the one thing they came to do.
 */
// The hosted edition has no server behind it: a report is triaged in the
// visitor's browser and goes nowhere. The page must not tell a member of the
// public otherwise — someone reporting a real hazard would believe it had
// reached the city.
const HOSTED = process.env.NEXT_PUBLIC_STATIC_API === "1";

export default function ReportPage() {
  return (
    <div className="min-h-screen bg-blueprint-950">
      <PublicNav />

      <section className="max-w-2xl mx-auto px-6 pt-32 pb-20">
        <div className="font-mono text-[10px] tracking-[0.2em] text-signal-amber/80 uppercase">
          Citizen report · M3
        </div>
        <h1 className="font-display text-3xl md:text-4xl text-paper mt-3">
          Report a problem
        </h1>
        <p className="text-paper/60 mt-4 leading-relaxed">
          Describe what you saw in your own words — a pothole, a broken traffic light, a
          flooded street. The report is classified, prioritised and routed to the right
          department automatically, and you&apos;ll see how it was triaged immediately
          below.
        </p>

        {HOSTED && (
          <p role="note" className="mt-6 border border-signal-amber/35 bg-signal-amber/5 rounded-lg px-4 py-3 text-[13px] text-paper/80 leading-relaxed">
            This public edition is not connected to a municipal service desk. Your report
            is triaged here in your browser to show how the platform works; it is{" "}
            <strong className="text-paper">not sent to any authority</strong> and is
            discarded when you leave. To report a real hazard, contact your municipality.
          </p>
        )}

        <div className="mt-8">
          <ComplaintForm showLocationPicker />
        </div>

        <div className="mt-10 grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[
            { n: "1", t: "Describe it", d: "Plain language — no form fields to figure out." },
            { n: "2", t: "Auto-triaged", d: "Category, priority and department are assigned instantly." },
            HOSTED
              ? { n: "3", t: "Routed", d: "Assigned to the department that would handle it." }
              : { n: "3", t: "Routed", d: "Sent straight to the team that handles it." },
          ].map((s) => (
            <div key={s.n} className="border hairline rounded-lg p-4">
              <div className="font-mono text-[10px] text-signal-amber/70">{s.n}</div>
              <div className="text-sm text-paper mt-1">{s.t}</div>
              <div className="text-xs text-paper/50 mt-1 leading-relaxed">{s.d}</div>
            </div>
          ))}
        </div>

        <p className="font-mono text-[10px] text-blueprint-line/40 mt-10 leading-relaxed">
          {HOSTED ? (
            <>
              Nothing you type here is stored or transmitted: the report exists only in
              this browser tab.{" "}
            </>
          ) : (
            <>
              Reports are anonymous unless you choose to include contact details in the text.
              City staff can see submitted reports to action them; other citizens cannot browse
              what you or anyone else has reported.{" "}
            </>
          )}
          Looking for the operations console instead?{" "}
          <Link href="/login" className="text-signal-amber hover:underline">Sign in</Link>.
        </p>
      </section>
    </div>
  );
}
