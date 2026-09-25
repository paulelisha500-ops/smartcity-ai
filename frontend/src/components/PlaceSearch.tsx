"use client";

import { useEffect, useId, useRef, useState } from "react";
import { api, PlaceResult } from "@/lib/api";

const ICON: Record<string, string> = {
  place: "◎",
  street: "—",
  building: "▣",
  amenity: "✚",
  landmark: "★",
};

/**
 * Geocoder box. Debounced so typing does not fire a query per keystroke, and
 * the in-flight request is abandoned when a newer one starts — otherwise a
 * slow early response can land after a fast later one and overwrite the
 * results the user is actually looking at.
 */
export default function PlaceSearch({
  onSelect,
  placeholder = "Search a place, building or street…",
  emirate,
}: {
  onSelect: (r: PlaceResult) => void;
  placeholder?: string;
  emirate?: string;
}) {
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(-1);
  const uid = useId();
  const listId = `${uid}-list`;
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (term.trim().length < 2) {
      setResults([]);
      return;
    }
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      setBusy(true);
      setFailed(false);
      try {
        const r = await api.searchPlaces(term, { emirate, limit: 10 });
        if (mine === seq.current) {
          setResults(r);
          setOpen(true);
          setActive(-1);
        }
      } catch {
        if (mine === seq.current) { setResults([]); setFailed(true); }
      } finally {
        if (mine === seq.current) setBusy(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [term, emirate]);

  // Close on outside click.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  function choose(r: PlaceResult) {
    onSelect(r);
    setTerm(r.name);
    setOpen(false);
  }

  function onKey(e: React.KeyboardEvent) {
    if (!open || results.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); choose(results[active >= 0 ? active : 0]); }
    else if (e.key === "Escape") setOpen(false);
  }

  return (
    <div ref={boxRef} className="relative w-full">
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 font-mono text-[11px] text-blueprint-line/50">
          ⌕
        </span>
        <input
          role="combobox"
          aria-expanded={open && results.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-label="Search places, buildings and streets"
          aria-activedescendant={active >= 0 ? `${uid}-opt-${active}` : undefined}
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onFocus={() => results.length && setOpen(true)}
          onKeyDown={onKey}
          placeholder={placeholder}
          className="w-full bg-blueprint-800/60 border hairline rounded-md pl-8 pr-3 py-2.5 text-[13px] font-mono text-paper placeholder:text-paper/30 transition-all duration-300 focus:outline-none focus:border-signal-amber focus:bg-blueprint-800 focus:ring-2 focus:ring-signal-amber/15"
        />
        {busy && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[10px] text-signal-amber/70">
            …
          </span>
        )}
      </div>

      {open && results.length > 0 && (
        <ul id={listId} role="listbox" aria-label="Search results" className="absolute z-[1000] mt-1 w-full max-h-80 overflow-y-auto rounded-md border hairline bg-blueprint-950/97 backdrop-blur-xl shadow-2xl">
          {results.map((r, i) => (
            <li key={`${r.type}-${r.id ?? r.name}-${i}`} id={`${uid}-opt-${i}`} role="option" aria-selected={i === active}>
              <button
                tabIndex={-1}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(r)}
                className={`w-full flex items-start gap-2.5 px-3 py-2.5 text-left transition-colors ${
                  i === active ? "bg-blueprint-800/70" : "hover:bg-blueprint-800/40"
                }`}
              >
                <span className="font-mono text-[11px] text-signal-amber/80 mt-0.5 w-3 shrink-0">
                  {ICON[r.category] ?? ICON[r.type] ?? "•"}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] text-paper/90 truncate">{r.name}</span>
                  <span className="block font-mono text-[10px] text-paper/40 truncate">
                    {[
                      r.subcategory?.replace(/_/g, " "),
                      r.ref,
                      r.emirate,
                      r.length_km ? `${r.length_km} km` : null,
                      r.distance_km ? `${r.distance_km} km away` : null,
                    ].filter(Boolean).join(" · ")}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {open && !busy && term.trim().length >= 2 && results.length === 0 && (
        <div role="status" className="absolute z-[1000] mt-1 w-full rounded-md border hairline bg-blueprint-950/97 backdrop-blur-xl px-3 py-3 font-mono text-[11px] text-paper/45">
          {failed
            ? "Search is unavailable right now. Check your connection and try again."
            : "Nothing found. Try a different spelling, or import places for this emirate on the UAE Road Network page."}
        </div>
      )}
    </div>
  );
}
