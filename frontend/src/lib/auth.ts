"use client";

/**
 * Client-side session state.
 *
 * The credential itself is an httpOnly, SameSite cookie set by the API on
 * login — page scripts (and so any XSS) cannot read it, and this module never
 * sees it. What is kept here is only the non-secret display state: who is
 * signed in, their role, and when the cookie expires. It drives the nav and
 * route gating; the API still enforces every permission server-side.
 */
const USER_KEY = "smartcity.user";

// The hosted edition is usually viewed embedded in another site's page, where
// a browser may refuse it storage. It holds no server session to lose, so the
// display state can live in memory for the visit instead.
const MEMORY_FALLBACK = process.env.NEXT_PUBLIC_STATIC_API === "1";
let memorySession: string | null = null;

export interface Session {
  email: string;
  role: string;
}

/**
 * Returns false when the browser refused to store the state (storage blocked,
 * private mode, quota). Callers must check it: otherwise login "succeeds" and
 * AppShell bounces the user straight back to the welcome page with no reason.
 */
export function saveSession(email: string, role: string, expiresAt: number): boolean {
  try {
    const value = JSON.stringify({ email, role, exp: expiresAt });
    if (MEMORY_FALLBACK) memorySession = value;
    localStorage.setItem(USER_KEY, value);
    return localStorage.getItem(USER_KEY) === value;
  } catch {
    return MEMORY_FALLBACK;
  }
}

export function getSession(): Session | null {
  try {
    let raw = memorySession;
    try {
      raw = localStorage.getItem(USER_KEY) ?? raw;
    } catch {
      /* storage blocked — fall through to the in-memory copy, if any */
    }
    if (!raw) return null;
    const user = JSON.parse(raw);
    // Mirror the cookie's expiry so the shell doesn't render a console whose
    // every request will 401.
    if (typeof user.exp === "number" && user.exp * 1000 < Date.now()) {
      clearSession();
      return null;
    }
    return { email: user.email, role: user.role };
  } catch {
    return null;
  }
}

export function clearSession() {
  memorySession = null;
  try {
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem("smartcity.token"); // left by older builds
  } catch {
    /* nothing to clear */
  }
}

export const ROLE_LABELS: Record<string, string> = {
  admin: "Administrator",
  traffic_officer: "Traffic Officer",
  city_planner: "City Planner",
  maintenance_department: "Maintenance Department",
  public_user: "Public User",
};

/**
 * Where a role lands after signing in.
 *
 * public_user is the one role with nothing to do in the operations console —
 * every console endpoint that isn't public civic data (camera fleet,
 * complaint list, ingestion, dispatch) is gated to staff roles on the
 * backend, so a citizen who somehow reached the console would just watch
 * requests fail. The account exists to show the citizen path, so it
 * lands there directly: /report, the same page reachable with no login at
 * all.
 */
export function homeRouteForRole(role: string): string {
  return role === "public_user" ? "/report" : "/";
}
