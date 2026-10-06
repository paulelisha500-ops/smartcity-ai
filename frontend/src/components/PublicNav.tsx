"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import BrandMark from "@/components/BrandMark";

const LINKS = [
  { href: "/welcome", label: "Home" },
  { href: "/report", label: "Report an Issue" },
  { href: "/about", label: "About" },
  { href: "/faq", label: "FAQ" },
];

export default function PublicNav() {
  const pathname = usePathname();
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // The phone menu closes on navigation and on Escape.
  useEffect(() => { setMenuOpen(false); }, [pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  // Transparent over the hero, frosted once you scroll past it — the bar
  // shouldn't cut a hard line across the photograph at rest.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`fixed top-0 inset-x-0 z-50 transition-all duration-500 ease-out-expo ${
        scrolled || menuOpen
          ? "bg-blueprint-950/90 backdrop-blur-xl border-b hairline"
          : "bg-transparent border-b border-transparent"
      }`}
    >
      <div className="max-w-6xl mx-auto px-6 h-[68px] flex items-center justify-between">
        <Link href="/welcome" className="hover:opacity-85 transition-opacity duration-300">
          <BrandMark size={34} />
        </Link>

        {/* From md up the links sit in the bar. Below it four links and a button
            do not fit beside the wordmark, so they move into a menu. */}
        <nav aria-label="Main" className="hidden md:flex items-center gap-1">
          {LINKS.map((l) => {
            const active = pathname === l.href;
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`relative px-3.5 py-2 text-[13px] transition-colors duration-300 ${
                  active ? "text-paper" : "text-paper/50 hover:text-paper"
                }`}
              >
                {l.label}
                <span
                  className={`absolute left-3.5 right-3.5 -bottom-0.5 h-px bg-signal-amber transition-transform duration-[400ms] ease-out-expo origin-left ${
                    active ? "scale-x-100" : "scale-x-0"
                  }`}
                />
              </Link>
            );
          })}
          <Link
            href="/login"
            className="btn-primary ml-3 px-5 py-2.5 rounded-md text-[12px] font-mono tracking-wide bg-signal-amber text-blueprint-950 hover:bg-signal-amber/90 transition-all duration-300 hover:shadow-[0_6px_22px_-6px_rgba(242,166,90,0.5)]"
          >
            SIGN IN
          </Link>
        </nav>

        <div className="flex md:hidden items-center gap-2">
          <Link
            href="/login"
            className="px-3.5 py-2 rounded-md text-[11px] font-mono tracking-wide bg-signal-amber text-blueprint-950"
          >
            SIGN IN
          </Link>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            aria-controls="public-menu"
            className="p-2 -mr-2 text-paper/80 hover:text-paper"
          >
            <span aria-hidden="true" className="font-mono text-lg leading-none">{menuOpen ? "✕" : "☰"}</span>
          </button>
        </div>
      </div>

      {menuOpen && (
        <nav id="public-menu" aria-label="Main" className="md:hidden border-t hairline px-6 py-3 animate-fade-in">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              aria-current={pathname === l.href ? "page" : undefined}
              // Tapping the page you are already on is not a navigation, so the
              // effect above never fires; close the menu here as well.
              onClick={() => setMenuOpen(false)}
              className={`block py-3 text-[15px] border-b border-blueprint-line/10 last:border-b-0 ${
                pathname === l.href ? "text-paper" : "text-paper/60"
              }`}
            >
              {l.label}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}
