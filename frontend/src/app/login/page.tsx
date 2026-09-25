"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import BrandMark from "@/components/BrandMark";
import { saveSession, homeRouteForRole, ROLE_LABELS } from "@/lib/auth";

// One-click sign-in for the seeded demo accounts. Baked in only for
// development builds (or when explicitly configured); a production build
// ships no default password.
const DEMO_PASSWORD =
  process.env.NEXT_PUBLIC_DEMO_PASSWORD ?? (process.env.NODE_ENV === "production" ? "" : "demo");
const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8001";

// Accounts defined in backend/app/routers/auth.py. The quick-select panel
// fills the form for whichever role you want to sign in as; wire this to an
// identity provider and the panel comes out.
const ACCOUNTS = [
  { email: "admin@city.gov", role: "admin" },
  { email: "officer@city.gov", role: "traffic_officer" },
  { email: "planner@city.gov", role: "city_planner" },
  { email: "maintenance@city.gov", role: "maintenance_department" },
  { email: "citizen@example.com", role: "public_user" },
];

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("admin@city.gov");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Requested-With": "smartcity-console" },
        credentials: "include",
        body: JSON.stringify({ email, password }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 401) {
        setError("Invalid credentials. Check the email and password.");
        return;
      }
      if (res.status === 422) {
        setError("Enter a valid email address and a password.");
        return;
      }
      if (!res.ok) {
        setError(`Sign-in failed (HTTP ${res.status}). Try again in a moment.`);
        return;
      }
      const data = await res.json();
      if (!saveSession(data.email ?? email, data.role, data.expires_at)) {
        setError("Your browser is blocking site storage, so the session can't be kept. Allow cookies/site data for this site (or leave private mode) and try again.");
        return;
      }
      router.push(homeRouteForRole(data.role));
    } catch {
      setError("Can't reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-2 bg-blueprint-950">
      {/* ------------------------------------------------ imagery panel */}
      <div className="relative hidden lg:block border-r hairline">
        <Image
          src="/emirates/abu-dhabi.jpg"
          alt="Abu Dhabi city"
          fill
          priority
          className="object-cover"
        />
        {/* Keep the photograph readable: darken only enough for the caption to
            sit legibly over the lower third. */}
        <div className="absolute inset-0 bg-gradient-to-t from-blueprint-950 via-blueprint-950/45 to-transparent" />
        <div className="absolute inset-0 bg-grid-fine bg-grid opacity-15" />

        <div className="relative h-full flex flex-col justify-end p-12">
          <div className="animate-slide-in flex items-center gap-1 mb-6">
            <span className="h-5 w-1.5 rounded-sm bg-uae-red" />
            <span className="h-5 w-1.5 rounded-sm bg-uae-green" />
            <span className="h-5 w-1.5 rounded-sm bg-paper" />
            <span className="h-5 w-1.5 rounded-sm bg-uae-black ring-1 ring-paper/25" />
          </div>
          <h2
            className="animate-slide-in font-display text-4xl text-paper max-w-md leading-[1.08]"
            style={{ animationDelay: "100ms" }}
          >
            City operations for the seven emirates
          </h2>
          <p
            className="animate-slide-in text-paper/55 text-sm mt-4 max-w-sm leading-relaxed"
            style={{ animationDelay: "200ms" }}
          >
            Traffic, citizen services, emergency dispatch and infrastructure planning on
            the real UAE road network.
          </p>
        </div>
      </div>

      {/* --------------------------------------------------- form panel */}
      <div className="flex flex-col">
        <div className="p-6">
          <Link href="/welcome" className="inline-block">
            <BrandMark size={36} />
          </Link>
        </div>

        <div className="flex-1 grid place-items-center px-6 pb-10">
          <div className="w-full max-w-sm animate-fade-up">
            <h1 className="font-display text-3xl text-paper tracking-tight">Sign in</h1>
            <p className="font-mono text-[10px] tracking-[0.18em] text-blueprint-line/60 mt-2 uppercase">
              Operations console access
            </p>

            <form onSubmit={submit} className="mt-8 space-y-4">
              <div>
                <label htmlFor="login-email" className="font-mono text-[10px] text-blueprint-line/60 uppercase tracking-wide block mb-1.5">
                  Email
                </label>
                <input
                  id="login-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="username"
                  className="w-full bg-blueprint-800/60 border hairline rounded-md px-3.5 py-3 text-sm font-mono text-paper transition-all duration-300 focus:outline-none focus:border-signal-amber focus:bg-blueprint-800 focus:ring-2 focus:ring-signal-amber/15"
                />
              </div>

              <div>
                <label htmlFor="login-password" className="font-mono text-[10px] text-blueprint-line/60 uppercase tracking-wide block mb-1.5">
                  Password
                </label>
                <input
                  id="login-password"
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  placeholder={DEMO_PASSWORD ? "demo account password" : "password"}
                  className="w-full bg-blueprint-800/60 border hairline rounded-md px-3.5 py-3 text-sm font-mono text-paper placeholder:text-paper/25 transition-all duration-300 focus:outline-none focus:border-signal-amber focus:bg-blueprint-800 focus:ring-2 focus:ring-signal-amber/15"
                />
              </div>

              {error && (
                <div role="alert" className="border border-signal-red/40 bg-signal-red/10 text-signal-red text-xs font-mono px-3 py-2.5">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={busy}
                className="btn-primary w-full py-3.5 rounded-md font-mono text-[13px] tracking-wide bg-signal-amber text-blueprint-950 hover:bg-signal-amber/90 disabled:opacity-50 transition-all duration-300 hover:shadow-[0_8px_26px_-8px_rgba(242,166,90,0.55)]"
              >
                {busy ? "SIGNING IN…" : "SIGN IN"}
              </button>
            </form>

            <div className="mt-8 border hairline rounded-lg overflow-hidden">
              <div className="px-4 py-2.5 border-b hairline font-mono text-[10px] text-blueprint-line/60 uppercase tracking-[0.14em] bg-blueprint-900/40">
                Sign in as
              </div>
              <div className="divide-y divide-blueprint-line/10">
                {ACCOUNTS.map((a) => (
                  <button
                    key={a.email}
                    type="button"
                    onClick={() => {
                      setEmail(a.email);
                      setPassword(DEMO_PASSWORD);
                      setError(null);
                    }}
                    className="group w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-blueprint-800/60 transition-colors duration-200"
                  >
                    <span className="font-mono text-[11px] text-paper/70 group-hover:text-paper transition-colors">
                      {a.email}
                    </span>
                    <span className="font-mono text-[10px] text-blueprint-line/55 group-hover:text-signal-amber/80 transition-colors">
                      {ROLE_LABELS[a.role]}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <p className="font-mono text-[10px] text-blueprint-line/40 mt-6 leading-relaxed">
              Access is role-based. Each account sees only the modules its role
              is cleared for.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
