"use client";

import Link from "next/link";
import BrandMark from "@/components/BrandMark";

export function SectionHead({
  eyebrow, title, lede,
}: { eyebrow: string; title: string; lede?: string }) {
  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-2.5">
        <span className="h-px w-7 bg-signal-amber/60" />
        <span className="font-mono text-[10px] tracking-[0.22em] text-signal-amber/85 uppercase">
          {eyebrow}
        </span>
      </div>
      <h2 className="font-display text-display-sm md:text-4xl text-paper mt-4">{title}</h2>
      {lede && <p className="text-paper/55 mt-4 leading-relaxed text-[15px]">{lede}</p>}
    </div>
  );
}

export function PublicFooter() {
  return (
    <footer className="border-t hairline bg-blueprint-950">
      <div className="max-w-6xl mx-auto px-6 py-12 flex flex-col md:flex-row gap-6 md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <BrandMark size={28} showWordmark={false} />
          <span className="font-mono text-[10px] text-blueprint-line/45">
            SmartCity AI — Urban Planning &amp; Traffic Platform
          </span>
        </div>
        <div className="flex gap-6 font-mono text-[11px] text-paper/45">
          <Link href="/about" className="hover:text-paper transition-colors">About</Link>
          <Link href="/faq" className="hover:text-paper transition-colors">FAQ</Link>
          <Link href="/login" className="hover:text-paper transition-colors">Sign in</Link>
        </div>
      </div>
    </footer>
  );
}
