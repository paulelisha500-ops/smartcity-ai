/**
 * The console's routes, and which roles each one is for.
 *
 * One list drives both the sidebar (what a role is offered) and the route
 * guard in AppShell (what a role may open), so the two cannot drift apart.
 */
export type NavItem = { href: string; label: string; code: string; roles?: string[] };

// Every backend router this nav points at has its own, authoritative role
// check (see the auth comments in each app/routers/*.py) — this list only
// decides what each role *sees a reason to click on*. Omitting `roles` shows
// the item to every staff role (public_user never reaches this shell at all;
// see homeRouteForRole in lib/auth.ts). Restricted items are the specialist
// tools: only OPERATORS (admin, traffic_officer) run camera and dispatch
// operations day to day, and only PLANNERS (admin, city_planner) do network
// ingestion, infrastructure editing and corridor design — matching the
// OPERATORS/PLANNERS groups the backend itself enforces.
export const NAV_GROUPS: { group: string; items: NavItem[] }[] = [
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

const ROUTES = NAV_GROUPS.flatMap((group) => group.items);

/** Is this path one of the console's own pages? */
export function isConsoleRoute(pathname: string): boolean {
  return ROUTES.some((item) => item.href === pathname);
}

/**
 * May this role open this console page?
 *
 * public_user is cleared for none of them: that account files reports on the
 * public site and has nothing to do in the console. The API enforces the same
 * rules on the data; this keeps the interface from offering a page it would
 * only fill with refusals.
 */
export function canAccess(role: string, pathname: string): boolean {
  if (role === "public_user") return false;
  const item = ROUTES.find((route) => route.href === pathname);
  return !item || !item.roles || item.roles.includes(role);
}
