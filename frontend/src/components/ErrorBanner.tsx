"use client";

/**
 * One consistent way to say "this failed, and here is why".
 *
 * `role="alert"` makes screen readers announce it when it appears — the old
 * pattern was a silent `.catch(() => {})`, which left an empty table with no
 * explanation to anyone, sighted or not.
 */
export default function ErrorBanner({
  message,
  onRetry,
}: {
  message: string | null;
  onRetry?: () => void;
}) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 border border-signal-red/40 bg-signal-red/10 text-signal-red text-xs font-mono px-4 py-3 rounded-md"
    >
      <span>{message}</span>
      {onRetry && (
        <button
          onClick={onRetry}
          className="shrink-0 border border-signal-red/50 px-2 py-1 rounded text-[10px] hover:bg-signal-red/10"
        >
          RETRY
        </button>
      )}
    </div>
  );
}
