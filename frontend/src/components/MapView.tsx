"use client";

import { useEffect, useRef, useState } from "react";
import { MapContainer, TileLayer, CircleMarker, Polyline, Popup, Tooltip, LayersControl, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { api } from "@/lib/api";
import type {
  TrafficReading, RoadDamagePoint, RoadLinkGeo, BorderCrossingRow, CameraRow, Project,
} from "@/lib/api";

/** Whole-UAE view: fits Abu Dhabi through Ras Al Khaimah plus both frontiers. */
export const UAE_CENTER: [number, number] = [24.6, 54.6];
export const UAE_ZOOM = 7;

function congestionColor(score: number) {
  if (score >= 70) return "#E2694F";
  if (score >= 45) return "#F2A65A";
  return "#6FBF8B";
}

/** Road styling by OSM class — motorways read heaviest, slip roads lightest. */
function roadStyle(link: RoadLinkGeo) {
  if (link.is_international) return { color: "#C792EA", weight: 3.0, opacity: 0.95 };
  switch (link.highway) {
    case "motorway": return { color: "#8FD9E8", weight: 2.4, opacity: 0.85 };
    case "trunk": return { color: "#6FBF8B", weight: 2.0, opacity: 0.75 };
    case "primary": return { color: "#F2A65A", weight: 1.5, opacity: 0.6 };
    case "secondary": return { color: "#9BB4C4", weight: 1.1, opacity: 0.45 };
    default: return { color: "#7C93A6", weight: 0.8, opacity: 0.35 };
  }
}

/**
 * Street-level styling. Deliberately quiet: at neighbourhood zoom there can be
 * thousands of these, and they are context for the arterials drawn above them,
 * not the subject. `interactive: false` skips hit-testing on every one of them.
 */
function streetStyle(s: RoadLinkGeo) {
  switch (s.highway) {
    case "secondary":
    case "secondary_link":
      return { color: "#9BB4C4", weight: 1.4, opacity: 0.55, interactive: false };
    case "tertiary":
    case "tertiary_link":
      return { color: "#8FA3B5", weight: 1.1, opacity: 0.5, interactive: false };
    default:
      return { color: "#6E8599", weight: 0.8, opacity: 0.45, interactive: false };
  }
}

function cameraColor(status: string) {
  switch (status) {
    case "online": return "#6FBF8B";
    case "offline": return "#E2694F";
    case "unauthorized": return "#F2A65A";
    default: return "#7C93A6";
  }
}

/**
 * Recentres the map when the caller changes `focus`.
 *
 * MapContainer's `center` prop is only read on first mount — react-leaflet
 * treats it as initial state, so a search result would never move the map
 * without imperatively calling flyTo through the map instance.
 */
function FocusFlyTo({ focus, zoom }: { focus?: { lat: number; lon: number }; zoom: number }) {
  const map = useMap();
  useEffect(() => {
    if (focus) map.flyTo([focus.lat, focus.lon], zoom, { duration: 0.9 });
  }, [focus?.lat, focus?.lon, zoom, map]);
  return null;
}

// Below this zoom a viewport holds too many streets to draw usefully.
const DETAIL_MIN_ZOOM = 13;
const DETAIL_CLASSES = [
  "secondary", "secondary_link", "tertiary", "tertiary_link",
  "residential", "unclassified", "living_street",
].join(",");

/**
 * Every street inside the visible area, once zoomed in.
 *
 * The main `roads` layer is the N longest links nationally — correct for a
 * country view, but it means the short residential streets that make up most
 * of the imported network never reach the screen. Past DETAIL_MIN_ZOOM this
 * asks the API for all street classes within the current viewport instead.
 *
 * Requests are debounced on `moveend` and sequenced, so dragging the map fires
 * one query when it settles and a slow earlier response can't overwrite a
 * newer one.
 */
function DetailStreets() {
  const map = useMap();
  const [streets, setStreets] = useState<RoadLinkGeo[]>([]);
  const [zoom, setZoom] = useState<number>(() => map.getZoom());
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = () => {
      const z = map.getZoom();
      setZoom(z);
      if (z < DETAIL_MIN_ZOOM) {
        setStreets([]);
        return;
      }
      const b = map.getBounds();
      const bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()]
        .map((v) => v.toFixed(5))
        .join(",");
      const mine = ++seq.current;
      setLoading(true);
      api.roads({ bbox, highway: DETAIL_CLASSES, limit: 4000 })
        .then((r) => { if (mine === seq.current) setStreets(r); })
        .catch(() => { /* keep whatever was drawn */ })
        .finally(() => { if (mine === seq.current) setLoading(false); });
    };

    const onMove = () => {
      clearTimeout(timer);
      timer = setTimeout(load, 350);
    };

    map.on("moveend", onMove);
    load();
    return () => {
      map.off("moveend", onMove);
      clearTimeout(timer);
    };
  }, [map]);

  return (
    <>
      {zoom >= DETAIL_MIN_ZOOM &&
        streets.map((s) => (
          <Polyline key={`st-${s.id}`} positions={s.geometry} pathOptions={streetStyle(s)} />
        ))}

      <div className="pointer-events-none absolute bottom-2 left-2 z-[1000] rounded-md bg-blueprint-950/85 px-2.5 py-1.5 font-mono text-[10px] text-paper/60 backdrop-blur">
        {zoom < DETAIL_MIN_ZOOM
          ? `Zoom in to see every street (level ${DETAIL_MIN_ZOOM}+, now ${zoom})`
          : loading
            ? "Loading streets…"
            : `${streets.length.toLocaleString()} streets in view · right-click to identify`}
      </div>
    </>
  );
}

/**
 * Right-click anywhere to identify the nearest street and named place.
 *
 * One handler on the map instead of a tooltip on each of thousands of street
 * polylines, reusing the reverse geocoder. Right-click (long-press on touch)
 * rather than left-click, because left-click already opens marker popups and
 * a map-level click handler would fire underneath them.
 *
 * Street and place names come from OpenStreetMap, which is user-contributed,
 * so the popup is assembled with textContent — never HTML strings — and a
 * name containing markup can only ever display as text.
 */
function ClickToIdentify() {
  const map = useMap();

  useEffect(() => {
    const onContext = async (e: L.LeafletMouseEvent) => {
      const { lat, lng } = e.latlng;
      const box = document.createElement("div");
      box.className = "font-mono text-xs";
      box.textContent = "Identifying…";
      const popup = L.popup().setLatLng(e.latlng).setContent(box).openOn(map);

      try {
        const r = await api.reverseGeocode(lat, lng);
        box.textContent = "";
        const add = (text: string, strong = false) => {
          const div = document.createElement("div");
          div.textContent = text;
          if (strong) div.style.fontWeight = "600";
          box.appendChild(div);
        };
        if (r.street) {
          add(r.street.name, true);
          add(`${(r.street.highway || "road").replace(/_/g, " ")} · ${Math.round(r.street.distance_m)} m`);
        }
        if (r.place) {
          add(`Near ${r.place.name} (${Math.round(r.place.distance_m)} m)`);
        }
        const emirate = r.street?.emirate || r.place?.emirate;
        if (emirate) add(emirate);
        if (!r.street && !r.place) add("Nothing named nearby");
        add(`${lat.toFixed(5)}, ${lng.toFixed(5)}`);
        popup.update();
      } catch {
        box.textContent = "Couldn't reach the geocoder.";
      }
    };

    map.on("contextmenu", onContext);
    return () => { map.off("contextmenu", onContext); };
  }, [map]);

  return null;
}

/** A named feature from the gazetteer, as drawn on the map. */
export interface PlaceMarker {
  id: number;
  name: string;
  category: string;
  subcategory: string | null;
  emirate: string | null;
  lat: number;
  lon: number;
  importance: number;
}

const PLACE_COLOR: Record<string, string> = {
  place: "#EDEEE7",
  amenity: "#E2694F",
  landmark: "#F2A65A",
  building: "#8FD9E8",
};

interface MapViewProps {
  places?: PlaceMarker[];
  traffic?: TrafficReading[];
  roadDamage?: RoadDamagePoint[];
  roads?: RoadLinkGeo[];
  borders?: BorderCrossingRow[];
  cameras?: CameraRow[];
  projects?: Project[];
  /** A driven route (emergency dispatch, existing corridor). */
  route?: [number, number][];
  /** A proposed new alignment — drawn dashed to distinguish it from reality. */
  proposedRoute?: [number, number][];
  /** A searched location to fly to and mark. */
  focus?: { lat: number; lon: number; label?: string };
  /** Load every street in the viewport when zoomed in, and enable right-click identify. */
  detailStreets?: boolean;
  center?: [number, number];
  zoom?: number;
}

export default function MapView({
  places = [],
  traffic = [],
  roadDamage = [],
  roads = [],
  borders = [],
  cameras = [],
  projects = [],
  route,
  proposedRoute,
  focus,
  detailStreets = false,
  center = UAE_CENTER,
  zoom = UAE_ZOOM,
}: MapViewProps) {
  return (
    <MapContainer
      center={center}
      zoom={zoom}
      scrollWheelZoom
      style={{ height: "100%", width: "100%" }}
      preferCanvas
    >
      {/*
        Esri Dark Gray Canvas. CARTO's dark-matter tiles now stamp
        "API KEY REQUIRED" across every tile unless you register a key; Esri's
        canvas basemaps serve keyless, carry no watermark, and are drawn as a
        muted cartographic canvas — which is exactly the instrument-panel
        backdrop this design wants. Base and labels are separate services, so
        the reference layer goes on top of the markers-free base.
      */}
      <TileLayer
        url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"
        attribution="Esri, HERE, Garmin, &copy; OpenStreetMap contributors"
        maxZoom={16}
      />
      <TileLayer
        url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}"
        maxZoom={16}
        // Labels only — the transparent reference tiles must sit above the
        // base but below the data layers.
        zIndex={2}
      />

      {/* Drawn before the LayersControl overlays so arterials sit on top. */}
      {detailStreets && <DetailStreets />}
      {detailStreets && <ClickToIdentify />}

      <LayersControl position="topright">
        {places.length > 0 && (
          <LayersControl.Overlay checked name={`Place names (${places.length})`}>
            <>
              {places.map((p) => {
                // Settlements with real weight get a permanent label so the map
                // reads like an atlas at country zoom; everything else labels on
                // hover, or a few thousand overlapping names become noise.
                const isMajor = p.category === "place" && p.importance >= 80;
                return (
                  <CircleMarker
                    key={`place-${p.id}`}
                    center={[p.lat, p.lon]}
                    radius={isMajor ? 4 : 2.5}
                    pathOptions={{
                      color: PLACE_COLOR[p.category] ?? "#EDEEE7",
                      fillColor: PLACE_COLOR[p.category] ?? "#EDEEE7",
                      fillOpacity: isMajor ? 0.95 : 0.7,
                      weight: isMajor ? 1.5 : 0.5,
                    }}
                  >
                    <Tooltip
                      permanent={isMajor}
                      direction="right"
                      offset={[6, 0]}
                      className="place-label"
                    >
                      {p.name}
                    </Tooltip>
                    <Popup>
                      <div className="font-mono text-xs">
                        <div className="font-semibold mb-1">{p.name}</div>
                        <div>{(p.subcategory || p.category).replace(/_/g, " ")}</div>
                        {p.emirate && <div>{p.emirate}</div>}
                      </div>
                    </Popup>
                  </CircleMarker>
                );
              })}
            </>
          </LayersControl.Overlay>
        )}

        {roads.length > 0 && (
          <LayersControl.Overlay checked name={`Road network (${roads.length})`}>
            <>
              {roads.map((link) => (
                <Polyline
                  key={`road-${link.id}`}
                  positions={link.geometry}
                  pathOptions={roadStyle(link)}
                >
                  <Popup>
                    <div className="font-mono text-xs">
                      <div className="font-semibold mb-1">
                        {link.name || link.ref || link.highway.replace("_", " ")}
                      </div>
                      {link.ref && <div>Route: {link.ref}</div>}
                      <div>Class: {link.highway}</div>
                      {link.lanes && <div>Lanes: {link.lanes}</div>}
                      {link.maxspeed_kmh && <div>Limit: {link.maxspeed_kmh} km/h</div>}
                      <div>Length: {(link.length_m / 1000).toFixed(2)} km</div>
                      {link.bridge && <div>Structure: bridge</div>}
                      {link.tunnel && <div>Structure: tunnel</div>}
                      {link.toll && <div>Toll (Salik) route</div>}
                      {link.is_international && <div>Cross-border corridor</div>}
                    </div>
                  </Popup>
                </Polyline>
              ))}
            </>
          </LayersControl.Overlay>
        )}

        {traffic.length > 0 && (
          <LayersControl.Overlay checked name={`Traffic (${traffic.length})`}>
            <>
              {traffic.map((t) => (
                <CircleMarker
                  key={`traffic-${t.intersection_id}`}
                  center={[t.lat, t.lon]}
                  radius={7 + t.congestion_score / 14}
                  pathOptions={{
                    color: congestionColor(t.congestion_score),
                    fillColor: congestionColor(t.congestion_score),
                    fillOpacity: 0.55,
                    weight: 1.5,
                  }}
                >
                  <Popup>
                    <div className="font-mono text-xs">
                      <div className="font-semibold mb-1">{t.intersection_name}</div>
                      <div>Congestion: {t.congestion_score}/100</div>
                      <div>Vehicles: {t.vehicle_count}</div>
                      <div>Avg speed: {t.avg_speed_kmh} km/h</div>
                      <div>Queue: {t.queue_length_m} m</div>
                    </div>
                  </Popup>
                </CircleMarker>
              ))}
            </>
          </LayersControl.Overlay>
        )}

        {cameras.length > 0 && (
          <LayersControl.Overlay checked name={`CCTV (${cameras.length})`}>
            <>
              {cameras
                .filter((c) => c.lat !== null && c.lon !== null)
                .map((c) => (
                  <CircleMarker
                    key={`cam-${c.id}`}
                    center={[c.lat as number, c.lon as number]}
                    radius={5}
                    pathOptions={{
                      color: cameraColor(c.status),
                      fillColor: cameraColor(c.status),
                      fillOpacity: 0.85,
                      weight: 1,
                    }}
                  >
                    <Popup>
                      <div className="font-mono text-xs">
                        <div className="font-semibold mb-1">{c.name}</div>
                        <div>Status: {c.status}</div>
                        <div>Protocol: {c.protocol.toUpperCase()}</div>
                        {c.resolution && <div>Resolution: {c.resolution}</div>}
                        {c.latency_ms && <div>Latency: {c.latency_ms} ms</div>}
                        <div>{c.authorized ? "Authorised" : "Not authorised"}</div>
                        {c.owner_org && <div>Operator: {c.owner_org}</div>}
                      </div>
                    </Popup>
                  </CircleMarker>
                ))}
            </>
          </LayersControl.Overlay>
        )}

        {borders.length > 0 && (
          <LayersControl.Overlay checked name={`Border crossings (${borders.length})`}>
            <>
              {borders.map((b) => (
                <CircleMarker
                  key={`border-${b.id}`}
                  center={[b.lat, b.lon]}
                  radius={8}
                  pathOptions={{
                    color: "#C792EA", fillColor: "#C792EA", fillOpacity: 0.5, weight: 2,
                  }}
                >
                  <Popup>
                    <div className="font-mono text-xs">
                      <div className="font-semibold mb-1">{b.name}</div>
                      <div>{b.country_a} ↔ {b.country_b}</div>
                      {b.road_ref && <div>Route: {b.road_ref}</div>}
                      <div>{b.open_24h ? "Open 24h" : "Restricted hours"}</div>
                      <div>{b.freight_enabled ? "Freight enabled" : "No freight"}</div>
                      {b.notes && <div className="mt-1 opacity-70">{b.notes}</div>}
                    </div>
                  </Popup>
                </CircleMarker>
              ))}
            </>
          </LayersControl.Overlay>
        )}

        {projects.length > 0 && (
          <LayersControl.Overlay checked name={`Projects (${projects.length})`}>
            <>
              {projects
                .filter((p) => p.lat !== null && p.lon !== null)
                .map((p) => (
                  <CircleMarker
                    key={`proj-${p.id}`}
                    center={[p.lat as number, p.lon as number]}
                    radius={9}
                    pathOptions={{
                      color: p.status === "completed" ? "#6FBF8B"
                        : p.status === "under_construction" ? "#F2A65A" : "#8FD9E8",
                      fillOpacity: 0.35,
                      weight: 2,
                      dashArray: p.status === "planned" ? "3,3" : undefined,
                    }}
                  >
                    <Popup>
                      <div className="font-mono text-xs max-w-[240px]">
                        <div className="font-semibold mb-1">{p.name}</div>
                        <div>{p.project_type.replace("_", " ")} · {p.status.replace("_", " ")}</div>
                        {p.authority && <div>{p.authority}</div>}
                        {p.capacity_vph && <div>Capacity: {p.capacity_vph.toLocaleString()} veh/h</div>}
                        {p.cost_aed_m && <div>Cost: AED {p.cost_aed_m}m</div>}
                        {p.length_m && <div>Length: {p.length_m} m</div>}
                      </div>
                    </Popup>
                  </CircleMarker>
                ))}
            </>
          </LayersControl.Overlay>
        )}

        {roadDamage.length > 0 && (
          <LayersControl.Overlay checked name={`Road damage (${roadDamage.length})`}>
            <>
              {roadDamage.map((d, i) => (
                <CircleMarker
                  key={`damage-${d.id}-${i}`}
                  center={[d.lat, d.lon]}
                  radius={6}
                  pathOptions={{
                    color: "#8FD9E8", fillColor: "#8FD9E8", fillOpacity: 0.4,
                    weight: 1, dashArray: "2,2",
                  }}
                >
                  <Popup>
                    <div className="font-mono text-xs">
                      <div className="font-semibold mb-1">{d.name}</div>
                      <div>{d.damage_type.replace("_", " ")}</div>
                      <div>Severity: {(d.severity * 100).toFixed(0)}%</div>
                    </div>
                  </Popup>
                </CircleMarker>
              ))}
            </>
          </LayersControl.Overlay>
        )}
      </LayersControl>

      {route && route.length > 1 && (
        <Polyline
          positions={route}
          pathOptions={{ color: "#6FBF8B", weight: 5, opacity: 0.9 }}
        />
      )}

      <FocusFlyTo focus={focus} zoom={zoom} />

      {focus && (
        <CircleMarker
          center={[focus.lat, focus.lon]}
          radius={11}
          pathOptions={{ color: "#F2A65A", fillColor: "#F2A65A", fillOpacity: 0.3, weight: 2.5 }}
        >
          {focus.label && (
            <Popup>
              <div className="font-mono text-xs font-semibold">{focus.label}</div>
            </Popup>
          )}
        </CircleMarker>
      )}

      {proposedRoute && proposedRoute.length > 1 && (
        <Polyline
          positions={proposedRoute}
          pathOptions={{ color: "#F2A65A", weight: 4, opacity: 0.9, dashArray: "8,6" }}
        />
      )}
    </MapContainer>
  );
}
