"use client";

import { useEffect, useState } from "react";
import { api, describeError, Complaint } from "@/lib/api";
import ComplaintForm from "@/components/ComplaintForm";

const PRIORITY_COLOR: Record<string, string> = {
  critical: "text-signal-red",
  high: "text-signal-amber",
  medium: "text-blueprint-line",
  low: "text-signal-green",
};
import ErrorBanner from "@/components/ErrorBanner";

export default function ComplaintsPage() {
  const [complaints, setComplaints] = useState<Complaint[]>([]);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    api.complaints().then(setComplaints).catch((e) => setError(describeError(e)));
  }

  useEffect(refresh, []);

  return (
    <div className="p-6 space-y-6">
      <header className="border-b hairline pb-4">
        <h1 className="font-display text-2xl text-paper">Citizen Complaint Analysis</h1>
        <p className="font-mono text-[11px] text-blueprint-line/60 mt-1">
          M3 — classification &middot; sentiment &middot; location extraction &middot; priority &middot; routing
        </p>
      </header>

      <ErrorBanner message={error} />

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1">
          <ComplaintForm onSubmitted={refresh} />
        </div>

        <div className="lg:col-span-2 blueprint-frame border hairline overflow-x-auto">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="bg-blueprint-800/60 text-paper/60 uppercase text-[10px]">
                <th className="text-left px-3 py-2">Report</th>
                <th className="text-left px-3 py-2">Category</th>
                <th className="text-left px-3 py-2">Priority</th>
                <th className="text-left px-3 py-2">Routed to</th>
                <th className="text-left px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {complaints.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-paper/40">
                    No reports yet — submit one on the left.
                  </td>
                </tr>
              )}
              {complaints.map((c) => (
                <tr key={c.id} className="border-t hairline align-top">
                  <td className="px-3 py-2 max-w-xs truncate" title={c.text}>{c.text}</td>
                  <td className="px-3 py-2">{c.category}</td>
                  <td className={`px-3 py-2 ${PRIORITY_COLOR[c.priority ?? "low"]}`}>{c.priority}</td>
                  <td className="px-3 py-2">{c.department}</td>
                  <td className="px-3 py-2">{c.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
