"use client";

import { useState } from "react";
import { api, describeError } from "@/lib/api";

const SUGGESTIONS = [
  "Show the busiest junctions",
  "Which roads should be widened?",
  "What needs maintenance most urgently?",
];

interface Turn {
  question: string;
  answer: string;
  sources: string[];
}

export default function PlannerPage() {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loading, setLoading] = useState(false);

  async function ask(q: string) {
    if (!q.trim()) return;
    setLoading(true);
    try {
      const res = await api.askPlanner(q);
      setTurns((t) => [...t, { question: q, answer: res.answer, sources: res.sources_used }]);
      setQuestion("");
    } catch (e) {
      setTurns((t) => [...t, { question: q, answer: describeError(e, "The planner couldn't answer that."), sources: [] }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <header className="border-b hairline pb-4">
        <h1 className="font-display text-2xl text-paper">AI City Planner</h1>
        <p className="font-mono text-[11px] text-blueprint-line/60 mt-1">
          M5 — retrieval-grounded answers over live congestion &amp; maintenance data
        </p>
      </header>

      <div className="flex flex-wrap gap-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            onClick={() => ask(s)}
            className="font-mono text-[11px] border hairline px-3 py-1.5 text-paper/70 hover:text-paper hover:border-signal-amber transition-colors"
          >
            {s}
          </button>
        ))}
      </div>

      <div className="space-y-4">
        {turns.map((t, i) => (
          <div key={i} className="space-y-2">
            <div className="font-mono text-xs text-blueprint-line">&gt; {t.question}</div>
            <div className="blueprint-frame border hairline bg-blueprint-800/30 p-4 text-sm text-paper">
              {t.answer}
              {t.sources.length > 0 && (
                <div className="mt-3 pt-2 border-t hairline font-mono text-[10px] text-paper/50">
                  Grounded in {t.sources.length} live data point(s) from the current city state.
                </div>
              )}
            </div>
          </div>
        ))}
        {turns.length === 0 && (
          <div className="text-xs text-paper/40 font-mono">
            Ask a question or pick a suggestion above.
          </div>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(question);
        }}
        className="flex gap-2"
      >
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask about congestion, road condition, or maintenance…"
          className="flex-1 bg-blueprint-900 border hairline px-3 py-2 text-sm text-paper placeholder:text-paper/30 focus:outline-none focus:border-signal-amber"
        />
        <button
          type="submit"
          disabled={loading}
          className="font-mono text-xs uppercase tracking-wide bg-signal-amber text-blueprint-950 px-4 py-2 disabled:opacity-40"
        >
          {loading ? "…" : "Ask"}
        </button>
      </form>
    </div>
  );
}
