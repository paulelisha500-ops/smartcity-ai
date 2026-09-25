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
        scrolled
          ? "bg-blueprint-950/80 backdrop-blur-xl border-b hairline"
          : "bg-transparent border-b border-transparent"
      }`}
    >
      <div className="max-w-6xl mx-auto px-6 h-[68px] flex items-center justify-between">
        <Link href="/welcome" className="hover:opacity-85 transition-opacity duration-300">
          <BrandMark size={34} />
        </Link>

        <nav className="flex items-center gap-1">
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
                  className={`absolute left-3.5 right-3.5 -bottom-0.5 h-px bg-signal-amber transition-transform duration-400 ease-out-expo origin-left ${
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
      </div>
    </header>
  );
}
