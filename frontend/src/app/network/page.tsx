"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { api, describeError, BorderCrossingRow, NetworkStatus, RoadLinkGeo, PlacesStatus, PlaceResult } from "@/lib/api";
import KPICard from "@/components/KPICard";
import PlaceSearch from "@/components/PlaceSearch";
import type { PlaceMarker } from "@/components/MapView";

const MapView = dynamic(() => import("@/components/MapView"), { ssr: false });

const CLASS_FILTERS = [
  { label: "Motorways", value: "motorway" },
  { label: "+ Trunk", value: "motorway,trunk" },
  { label: "+ Primary", value: "motorway,trunk,primary" },
  { label: "All", value: "" },
];

export default function NetworkPage() {
  const [status, setStatus] = useState<NetworkStatus | null>(null);
  const [roads, setRoads] = useState<RoadLinkGeo[]>([]);
  const [borders, setBorders] = useState<BorderCrossingRow[]>([]);
  const [corridors, setCorridors] = useState<Record<string, any[]>>({});
  const [highway, setHighway] = useState("motorway,trunk");
  const [intlOnly, setIntlOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // Gazetteer state
  const [places, setPlaces] = useState<PlacesStatus | null>(null);
  const [selected, setSelected] = useState<PlaceResult | null>(null);
  const [mapCenter, setMapCenter] = useState<[number, number]>([24.6, 54.6]);
  const [mapZoom, setMapZoom] = useState(7);
  const [importing, setImporting] = useState<string | null>(null);
  const [mapPlaces, setMapPlaces] = useState<PlaceMarker[]>([]);
  const [showPlaces, setShowPlaces] = useState(true);

  const loadStatus = useCallback(async () => {
    try {
      const s = await api.networkStatus();
      setStatus(s);
      return s;
    } catch (e) {
      setNote(describeError(e));
      return null;
    }
  }, []);

  const loadGeo = useCallback(async () => {
    try {
      const [r, b, c] = await Promise.all([
        api.roads({ highway: highway || undefined, limit: 1200, international_only: intlOnly }),
        api.borderCrossings(),
        api.corridors(),
      ]);
      setRoads(r);
      setBorders(b);
      setCorridors(c.corridors || {});
    } catch {
      /* network not ingested yet — the empty state explains what to do */
    }
  }, [highway, intlOnly]);

  const loadPlaces = useCallback(async () => {
    try {
      // Status for the counters, plus the most important ~1,200 features for
      // the map. Importance-ordered on the server, so cities and hospitals
      // arrive before corner shops; the full 16k stays searchable.
      const [st, pts] = await Promise.all([
        api.placesStatus(),
        api.places({ limit: 1200 }),
      ]);
      setPlaces(st);
      setMapPlaces(pts as PlaceMarker[]);
    } catch {
      /* gazetteer not loaded yet */
    }
  }, []);

  useEffect(() => {
    loadStatus().then((s) => {
      if (s?.ingested) loadGeo();
    });
    loadPlaces();
  }, [loadStatus, loadGeo, loadPlaces]);

  function goTo(r: PlaceResult) {
    setSelected(r);
    setMapCenter([r.lat, r.lon]);
    setMapZoom(r.type === "street" ? 13 : 15);
  }

  async function importFor(emirate: string) {
    setImporting(emirate);
    setNote(`Importing places, buildings and streets for ${emirate}… this runs in the background.`);
    try {
      await Promise.all([api.ingestPlaces(emirate), api.ingestStreets(emirate)]);
      setNote(`${emirate} import started. Counts update as data lands.`);
      const poll = setInterval(async () => {
        await Promise.all([loadPlaces(), loadStatus()]);
      }, 8000);
      setTimeout(() => clearInterval(poll), 5 * 60 * 1000);
    } catch (e) {
      setNote(`Couldn't start the ${emirate} import: ${describeError(e)}`);
    } finally {
      setImporting(null);
    }
  }

  async function ingest() {
    setBusy(true);
    setNote("Downloading the UAE highway network from OpenStreetMap — this takes 30–90s…");
    try {
      await api.ingestNetwork(true); // inline so we know when it's actually done
      const s = await loadStatus();
      if (s?.ingested) {
        await loadGeo();
        setNote(`Loaded ${s.road_links.toLocaleString()} links · ${s.network_km.toLocaleString()} km.`);
      }
    } catch (e) {
      setNote(`Ingest failed: ${describeError(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-6 space-y-6">
      <header className="flex items-end justify-between border-b hairline pb-4">
        <div>
          <h1 className="font-display text-2xl text-paper">UAE Road Network</h1>
          <p className="font-mono text-[11px] text-blueprint-line/60 mt-1">
            M10 — real OpenStreetMap geometry · all seven emirates · cross-border corridors
          </p>
        </div>
        <button
          onClick={ingest}
          disabled={busy}
          className="border hairline px-3 py-1.5 font-mono text-[11px] bg-signal-amber/80 text-blueprint-950 hover:bg-signal-amber disabled:opacity-40"
        >
          {busy ? "INGESTING…" : status?.ingested ? "RE-INGEST" : "INGEST NETWORK"}
        </button>
      </header>

      {note && (
        <div role="status" className="border hairline bg-blueprint-800/40 text-xs font-mono px-4 py-3 text-paper/70">
          {note}
        </div>
      )}

      {/* Geocoder — searches the gazetteer and every named street at once. */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <PlaceSearch onSelect={goTo} />
        </div>
        {selected && (
          <div className="blueprint-frame border hairline rounded-lg px-4 py-3 bg-blueprint-800/30">
            <div className="font-mono text-[10px] text-blueprint-line/60 uppercase tracking-wide">
              Located
            </div>
            <div className="text-sm text-paper/90 mt-1 truncate">{selected.name}</div>
            <div className="font-mono text-[10px] text-paper/45 mt-0.5">
              {[selected.subcategory?.replace(/_/g, " "), selected.emirate,
                `${selected.lat.toFixed(4)}, ${selected.lon.toFixed(4)}`]
                .filter(Boolean).join(" · ")}
            </div>
          </div>
        )}
      </section>

      <section className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <KPICard code="M10.1" label="Road links" value={status?.road_links?.toLocaleString() ?? "—"} />
        <KPICard code="M10.2" label="Network" value={status?.network_km?.toLocaleString() ?? "—"} unit="km" />
        <KPICard code="M10.3" label="Border crossings" value={status?.border_crossings ?? "—"} tone="good" />
        <KPICard code="M10.4" label="Int'l links" value={status?.international_links ?? "—"} />
        <KPICard
          code="M10.5"
          label="Named places"
          value={places?.total_places?.toLocaleString() ?? "—"}
          tone="good"
        />
      </section>

      {/* Per-emirate detail import: streets, buildings and place names. */}
      <section className="blueprint-frame border hairline rounded-lg p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div>
            <div className="font-mono text-[10px] text-blueprint-line/60 uppercase tracking-wide">
              Detail import — streets, buildings &amp; place names
            </div>
            <div className="font-mono text-[10px] text-paper/40 mt-1">
              Named features only. Unnamed building outlines number in the millions and
              are excluded by design.
            </div>
          </div>
          <span className="font-mono text-[10px] text-paper/40">
            {places?.total_places ? `${places.total_places.toLocaleString()} places loaded` : "no places yet"}
          </span>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2">
          {(places?.emirates_available ?? []).map((em) => {
            const n = places?.by_emirate?.[em] ?? 0;
            return (
              <button
                key={em}
                onClick={() => importFor(em)}
                disabled={importing !== null}
                className={`group border hairline rounded-md px-3 py-2.5 text-left transition-all duration-300 disabled:opacity-40 ${
                  n > 0
                    ? "border-signal-green/35 bg-signal-green/5 hover:border-signal-green/60"
                    : "hover:border-signal-amber hover:bg-blueprint-800/40"
                }`}
              >
                <div className="text-[12px] text-paper/85 truncate">{em}</div>
                <div className="font-mono text-[10px] mt-0.5">
                  {importing === em ? (
                    <span className="text-signal-amber">starting…</span>
                  ) : n > 0 ? (
                    <span className="text-signal-green">{n.toLocaleString()} places</span>
                  ) : (
                    <span className="text-paper/35 group-hover:text-signal-amber">import →</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {!status?.ingested && !busy && (
        <div className="blueprint-frame border hairline p-8 text-center">
          <div className="font-mono text-sm text-paper/70 mb-2">
            The real road network hasn&apos;t been downloaded yet.
          </div>
          <div className="font-mono text-[11px] text-paper/45 max-w-xl mx-auto">
            INGEST NETWORK pulls every motorway, trunk, primary and secondary road in the
            UAE from OpenStreetMap and stores the true geometry in PostGIS. Routing,
            corridor design and this map all run off it afterwards.
          </div>
        </div>
      )}

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {CLASS_FILTERS.map((f) => (
              <button
                key={f.label}
                onClick={() => setHighway(f.value)}
                className={`border hairline px-3 py-1 font-mono text-[10px] ${
                  highway === f.value
                    ? "border-signal-amber text-paper bg-blueprint-800/60"
                    : "text-paper/60 hover:text-paper"
                }`}
              >
                {f.label}
              </button>
            ))}
            <label className="flex items-center gap-2 font-mono text-[10px] text-paper/60 ml-2">
              <input
                type="checkbox"
                checked={intlOnly}
                onChange={(e) => setIntlOnly(e.target.checked)}
              />
              CROSS-BORDER ONLY
            </label>
            <label className="flex items-center gap-2 font-mono text-[10px] text-paper/60 ml-2">
              <input
                type="checkbox"
                checked={showPlaces}
                onChange={(e) => setShowPlaces(e.target.checked)}
              />
              PLACE NAMES
            </label>
            <span className="font-mono text-[10px] text-paper/35 ml-auto">
              {roads.length} links · {showPlaces ? mapPlaces.length : 0} places drawn
            </span>
          </div>

          <div className="blueprint-frame border hairline rounded-lg h-[55vh] min-h-[300px] lg:h-[520px] overflow-hidden">
            <MapView
              detailStreets
              places={showPlaces ? mapPlaces : []}
              roads={roads}
              borders={borders}
              center={mapCenter}
              zoom={mapZoom}
              focus={selected ? { lat: selected.lat, lon: selected.lon, label: selected.name } : undefined}
            />
          </div>
        </div>

        <div className="space-y-4">
          <div className="blueprint-frame border hairline p-4">
            <div className="font-mono text-[10px] text-blueprint-line/60 mb-3">
              M10 — INTERNATIONAL CORRIDORS
            </div>
            {Object.keys(corridors).length === 0 && (
              <div className="text-xs text-paper/40 font-mono py-6 text-center">
                Ingest the network to load border crossings.
              </div>
            )}
            {Object.entries(corridors).map(([country, list]) => (
              <div key={country} className="mb-4">
                <div className="font-mono text-[11px] text-signal-amber mb-1">
                  → {country} ({list.length})
                </div>
                {list.map((c: any, i: number) => (
                  <div key={i} className="border-t hairline py-2 text-[11px] font-mono">
                    <div className="text-paper/85">{c.crossing}</div>
                    <div className="text-paper/45 text-[10px]">
                      {c.emirate ?? "—"}
                      {c.declared_ref && ` · ${c.declared_ref}`}
                      {c.connecting_routes?.length > 0 &&
                        ` · via ${c.connecting_routes.join(", ")}`}
                    </div>
                    <div className="text-[10px] mt-0.5">
                      <span className={c.freight_enabled ? "text-signal-green" : "text-paper/40"}>
                        {c.freight_enabled ? "freight" : "no freight"}
                      </span>
                      {c.open_24h && <span className="text-paper/40"> · 24h</span>}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>

          {status?.by_class && Object.keys(status.by_class).length > 0 && (
            <div className="blueprint-frame border hairline p-4">
              <div className="font-mono text-[10px] text-blueprint-line/60 mb-2">
                BY ROAD CLASS
              </div>
              {Object.entries(status.by_class)
                .sort((a, b) => b[1] - a[1])
                .map(([cls, n]) => (
                  <div key={cls} className="flex justify-between text-[11px] font-mono py-0.5">
                    <span className="text-paper/60">{cls}</span>
                    <span className="text-paper/85">{n.toLocaleString()}</span>
                  </div>
                ))}
            </div>
          )}
        </div>
      </section>

      <footer className="font-mono text-[10px] text-blueprint-line/40">
        Source: OpenStreetMap contributors via the Overpass API. Purple = cross-border
        corridor · cyan = motorway · green = trunk · amber = primary.
      </footer>
    </div>
  );
}
