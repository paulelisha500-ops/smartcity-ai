"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import BrandMark from "@/components/BrandMark";
import { api } from "@/lib/api";
import { getSession, clearSession, ROLE_LABELS } from "@/lib/auth";

type NavItem = { href: string; label: string; code: string; roles?: string[] };

// Every backend router this nav points at has its own, authoritative role
// check (see the auth comments in each app/routers/*.py) — this list only
// decides what each role *sees a reason to click on*. Omitting `roles` shows
// the item to every staff role (public_user never reaches this shell at all;
// see homeRouteForRole in lib/auth.ts). Restricted items are the specialist
// tools: only OPERATORS (admin, traffic_officer) run camera and dispatch
// operations day to day, and only PLANNERS (admin, city_planner) do network
// ingestion, infrastructure editing and corridor design — matching the
// OPERATORS/PLANNERS groups the backend itself enforces.
const NAV_GROUPS: { group: string; items: NavItem[] }[] = [
  {
    group: "Operations",
    items: [
      { href: "/", label: "Digital Twin", code: "M6" },
      { href: "/traffic", label: "Traffic Analysis", code: "M1/M4", roles: ["admin", "traffic_officer", "city_planner"] },
      { href: "/cameras", label: "CCTV Network", code: "M9", roles: ["admin", "traffic_officer"] },
      { href: "/dispatch", label: "Emergency Dispatch", code: "M7", roles: ["admin", "traffic_officer"] },
    ],
  },
  {
    group: "City services",
    items: [
      { href: "/complaints", label: "Citizen Complaints", code: "M3" },
      { href: "/maintenance", label: "Road Maintenance", code: "M2", roles: ["admin", "maintenance_department", "city_planner"] },
    ],
  },
  {
    group: "Planning",
    items: [
      { href: "/network", label: "UAE Road Network", code: "M10", roles: ["admin", "city_planner"] },
      { href: "/infrastructure", label: "Bridges & Projects", code: "M11", roles: ["admin", "city_planner"] },
      { href: "/route-design", label: "New Route Design", code: "M12", roles: ["admin", "city_planner"] },
      { href: "/planner", label: "AI City Planner", code: "M5", roles: ["admin", "city_planner"] },
    ],
  },
  {
    group: "Reports",
    items: [
      { href: "/analytics", label: "Government Analytics", code: "M8" },
    ],
  },
];

export default function Sidebar({ open = false, onNavigate }: { open?: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<{ email: string; role: string } | null>(null);

  useEffect(() => {
    const s = getSession();
    if (s) setUser({ email: s.email, role: s.role });
  }, [pathname]);

  function signOut() {
    // Ask the API to expire the httpOnly cookie; JS can't delete it itself.
    api.logout().catch(() => {});
    clearSession();
    router.replace("/welcome");
  }

  return (
    <aside
      id="app-sidebar"
      aria-label="Main navigation"
      // Below lg the sidebar is an off-canvas drawer: a fixed 256px column left
      // ~120px for content on a 375px phone. From lg up it is the static column.
      className={`fixed inset-y-0 left-0 z-50 w-64 max-w-[85vw] shrink-0 border-r hairline bg-blueprint-950 lg:bg-blueprint-950/60 flex flex-col transition-transform duration-300 lg:static lg:translate-x-0 ${
        open ? "translate-x-0" : "-translate-x-full"
      }`}
    >
      <div className="px-5 py-5 border-b hairline">
        <Link href="/welcome" className="block hover:opacity-90 transition-opacity">
          <BrandMark size={34} subtitle="UAE CITY OPS · 12 MODULES" />
        </Link>
      </div>

      <nav className="flex-1 py-3 overflow-y-auto">
        {NAV_GROUPS.map((section) => {
          const items = section.items.filter(
            (item) => !item.roles || (user && item.roles.includes(user.role))
          );
          if (items.length === 0) return null;

          return (
          <div key={section.group} className="mb-3">
            <div className="px-5 pb-1 font-mono text-[9px] uppercase tracking-wider text-blueprint-line/40">
              {section.group}
            </div>
            {items.map((item) => {
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  className={`group relative flex items-center justify-between px-5 py-2.5 text-[13px] transition-all duration-300 ${
                    active
                      ? "bg-blueprint-800/60 text-paper"
                      : "text-paper/55 hover:text-paper hover:bg-blueprint-800/30 hover:pl-6"
                  }`}
                >
                  <span
                    className={`absolute left-0 inset-y-0 w-0.5 bg-signal-amber transition-transform duration-300 ease-out-expo origin-top ${
                      active ? "scale-y-100" : "scale-y-0 group-hover:scale-y-100"
                    }`}
                  />
                  <span>{item.label}</span>
                  <span className="font-mono text-[9px] text-blueprint-line/50">{item.code}</span>
                </Link>
              );
            })}
          </div>
          );
        })}
      </nav>

      <div className="px-5 py-4 border-t hairline">
        <div className="font-mono text-[10px] text-blueprint-line/60 mb-1">SIGNED IN AS</div>
        <div className="text-xs text-paper/85 truncate" title={user?.email}>
          {user?.email ?? "—"}
        </div>
        <div className="font-mono text-[10px] text-signal-amber/80 mt-0.5">
          {user ? ROLE_LABELS[user.role] ?? user.role : ""}
        </div>
        <button
          onClick={signOut}
          className="mt-3 w-full border hairline px-2 py-1.5 font-mono text-[10px] text-paper/60 hover:text-paper hover:border-signal-red transition-colors"
        >
          SIGN OUT
        </button>
      </div>
    </aside>
  );
}
