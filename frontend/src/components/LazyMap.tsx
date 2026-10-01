"use client";

import dynamic from "next/dynamic";

/**
 * The map, loaded on the client only (Leaflet needs `window`). While its code
 * arrives the panel shows a quiet placeholder instead of an empty box.
 */
const LazyMap = dynamic(() => import("@/components/MapView"), {
  ssr: false,
  loading: () => <div className="h-full w-full map-loading" aria-hidden="true" />,
});

export default LazyMap;
