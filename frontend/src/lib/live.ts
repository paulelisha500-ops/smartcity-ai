"use client";

import { useEffect, useRef, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8001";
const WS_URL = API_URL.replace(/^http/, "ws") + "/ws/live";

export interface CongestionUpdateEvent {
  type: "congestion_update";
  intersection_id: number;
  intersection_name?: string;
  congestion_score: number;
}

export interface NewComplaintEvent {
  type: "new_complaint";
  id: number;
  category: string | null;
  priority: string | null;
  department: string | null;
  lat: number | null;
  lon: number | null;
  ts: string;
}

export interface CameraStatusEvent {
  type: "camera_status";
  camera_id: number;
  name: string;
  status: string;
  emirate: string | null;
}

export type LiveEvent = CongestionUpdateEvent | NewComplaintEvent | CameraStatusEvent;

/**
 * Subscribes to the /ws/live feed for the lifetime of the calling component.
 *
 * Reconnects with capped exponential backoff on drop — a laptop closing its
 * lid, a backend restart, a flaky network shouldn't require a page reload to
 * recover. `onEvent` is called for every message; `connected` reflects the
 * current socket state so callers can show a live/offline indicator.
 *
 * `onEvent` is taken as a ref internally so the effect doesn't need it in its
 * dependency array — otherwise a caller passing an inline arrow function
 * (the common case) would reconnect the socket on every render.
 */
export function useLiveSocket(onEvent: (event: LiveEvent) => void) {
  const [connected, setConnected] = useState(false);
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let backoffMs = 1000;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      socket = new WebSocket(WS_URL);

      socket.onopen = () => {
        backoffMs = 1000;
        setConnected(true);
      };

      socket.onmessage = (msg) => {
        try {
          handlerRef.current(JSON.parse(msg.data) as LiveEvent);
        } catch {
          /* malformed frame — ignore rather than crash the socket handler */
        }
      };

      socket.onclose = () => {
        setConnected(false);
        if (stopped) return;
        retryTimer = setTimeout(connect, backoffMs);
        backoffMs = Math.min(backoffMs * 2, 30000);
      };

      // onerror is always followed by onclose per the WebSocket spec, so the
      // reconnect logic lives in onclose only — no duplicate handling here.
      socket.onerror = () => {};
    };

    connect();

    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      socket?.close();
    };
  }, []);

  return { connected };
}
