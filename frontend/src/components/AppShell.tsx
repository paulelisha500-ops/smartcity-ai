"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Sidebar from "@/components/Sidebar";
import { getSession } from "@/lib/auth";

/**
 * Decides which chrome a route gets, and gates the console behind a session.
 *
 * Public routes render edge-to-edge with no sidebar; console routes get the
 * operations sidebar and require a valid token. The gate is a UX affordance,
 * not a security boundary — the API enforces roles server-side, which is where
 * authorisation has to live.
 */
const PUBLIC_ROUTES = ["/welcome", "/login", "/about", "/faq", "/report"];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isPublic = PUBLIC_ROUTES.includes(pathname);
  const [checked, setChecked] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // Close the drawer on navigation and on Escape.
  useEffect(() => { setMenuOpen(false); }, [pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  useEffect(() => {
    if (isPublic) {
      setChecked(true);
      return;
    }
    if (!getSession()) {
      router.replace("/welcome");
      return;
    }
    setChecked(true);
  }, [pathname, isPublic, router]);

  // A 401 from any request (token expired mid-session) fires this from
  // lib/api.ts. Listened for at the shell level rather than per-page, so
  // every console page gets it for free instead of each poll loop needing
  // its own expiry handling.
  useEffect(() => {
    const onExpired = () => router.replace("/login");
    window.addEventListener("smartcity:auth-expired", onExpired);
    return () => window.removeEventListener("smartcity:auth-expired", onExpired);
  }, [router]);

  if (isPublic) {
    return <main className="min-h-screen">{children}</main>;
  }

  // Avoid painting the console for an instant before redirecting away.
  if (!checked) {
    return (
      <main className="min-h-screen grid place-items-center">
        <div className="font-mono text-xs text-blueprint-line/50">Checking session…</div>
      </main>
    );
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar open={menuOpen} onNavigate={() => setMenuOpen(false)} />

      {/* Backdrop behind the mobile drawer; tapping it closes the menu. */}
      {menuOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
          onClick={() => setMenuOpen(false)}
          aria-hidden="true"
        />
      )}

      <div className="flex-1 min-w-0 flex flex-col">
        <div className="lg:hidden sticky top-0 z-30 flex items-center gap-3 px-4 h-12 border-b hairline bg-blueprint-950/90 backdrop-blur">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            aria-controls="app-sidebar"
            className="p-2 -ml-2 text-paper/80 hover:text-paper"
          >
            <span aria-hidden="true" className="font-mono text-lg leading-none">{menuOpen ? "✕" : "☰"}</span>
          </button>
          <span className="font-display text-sm text-paper">SmartCity AI</span>
        </div>
        <main className="flex-1 min-w-0">{children}</main>
      </div>
    </div>
  );
}
