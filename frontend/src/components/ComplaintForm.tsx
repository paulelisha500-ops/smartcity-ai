"use client";

import { useState } from "react";
import { api, describeError, Complaint, PlaceResult } from "@/lib/api";
import PlaceSearch from "@/components/PlaceSearch";

const PRIORITY_COLOR: Record<string, string> = {
  critical: "text-signal-red",
  high: "text-signal-amber",
  medium: "text-blueprint-line",
  low: "text-signal-green",
};

export default function ComplaintForm({
  onSubmitted,
  showLocationPicker = false,
}: {
  onSubmitted?: (c: Complaint) => void;
  /** Optional geocoder box so a report carries a real coordinate, not just
   *  whatever the NLP pipeline can infer from the free text. Off by default
   *  so the console's compact complaints table isn't disrupted by it. */
  showLocationPicker?: boolean;
}) {
  const [text, setText] = useState("");
  const [location, setLocation] = useState<PlaceResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Complaint | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (text.trim().length < 5) return;
    setLoading(true);
    setError(null);
    try {
      const complaint = await api.submitComplaint({
        text,
        lat: location?.lat,
        lon: location?.lon,
      });
      setResult(complaint);
      setText("");
      setLocation(null);
      onSubmitted?.(complaint);
    } catch (err) {
      setError(describeError(err, "Could not submit your report. Please try again."));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="blueprint-frame bg-blueprint-800/40 border hairline p-5">
      <div className="font-mono text-[10px] text-blueprint-line/60 mb-3">
        M3 — SUBMIT A REPORT
      </div>
      <form onSubmit={handleSubmit} className="space-y-3">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='e.g. "Huge pothole near the hospital, been there for two weeks."'
          rows={3}
          maxLength={2000}
          aria-label="Describe the problem"
          className="w-full bg-blueprint-900 border hairline px-3 py-2 text-sm text-paper placeholder:text-paper/30 focus:outline-none focus:border-signal-amber resize-none"
        />

        {showLocationPicker && (
          <div>
            <PlaceSearch
              placeholder="Optional — pin the exact location…"
              onSelect={setLocation}
            />
            {location && (
              <div className="mt-1.5 flex items-center justify-between font-mono text-[10px] text-signal-amber/80">
                <span>📍 {location.name}</span>
                <button
                  type="button"
                  onClick={() => setLocation(null)}
                  className="text-paper/40 hover:text-paper"
                >
                  clear
                </button>
              </div>
            )}
          </div>
        )}

        <button
          type="submit"
          disabled={loading || text.trim().length < 5}
          className="font-mono text-xs uppercase tracking-wide bg-signal-amber text-blueprint-950 px-4 py-2 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-signal-amber/90 transition-colors"
        >
          {loading ? "Analyzing…" : "Submit report"}
        </button>
      </form>

      {error && <div role="alert" className="mt-3 text-xs text-signal-red font-mono">{error}</div>}

      {result && (
        <div role="status" className="mt-4 border-t hairline pt-3 text-xs font-mono space-y-1">
          <div className="text-paper/60">AI analysis result:</div>
          <div>
            Category: <span className="text-paper">{result.category}</span>
          </div>
          <div>
            Priority:{" "}
            <span className={PRIORITY_COLOR[result.priority ?? "low"]}>{result.priority}</span>
          </div>
          <div>
            Routed to: <span className="text-paper">{result.department}</span>
          </div>
        </div>
      )}
    </div>
  );
}
