import Link from "next/link";
import BrandMark from "@/components/BrandMark";

export default function NotFound() {
  return (
    <div className="min-h-screen bg-blueprint-950 grid place-items-center px-6">
      <div className="max-w-md text-center">
        <div className="flex justify-center">
          <BrandMark size={40} />
        </div>
        <div className="font-mono text-[10px] tracking-[0.22em] text-signal-amber/80 uppercase mt-10">
          Error 404
        </div>
        <h1 className="font-display text-3xl text-paper mt-3">Page not found</h1>
        <p className="text-paper/55 mt-4 leading-relaxed text-sm">
          There is nothing at this address. It may have been mistyped, or the page may
          have moved.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link
            href="/welcome"
            className="btn-primary px-5 py-2.5 rounded-md font-mono text-[12px] tracking-wide bg-signal-amber text-blueprint-950 hover:bg-signal-amber/90"
          >
            BACK TO THE HOME PAGE
          </Link>
          <Link
            href="/login"
            className="px-5 py-2.5 rounded-md font-mono text-[12px] tracking-wide border hairline text-paper/75 hover:text-paper hover:border-signal-amber"
          >
            SIGN IN
          </Link>
        </div>
      </div>
    </div>
  );
}
