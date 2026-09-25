interface KPICardProps {
  label: string;
  value: string | number;
  unit?: string;
  code: string;
  tone?: "default" | "good" | "warn" | "bad";
}

const TONE_COLOR: Record<string, string> = {
  default: "text-paper",
  good: "text-signal-green",
  warn: "text-signal-amber",
  bad: "text-signal-red",
};

const TONE_GLOW: Record<string, string> = {
  default: "",
  good: "group-hover:shadow-[0_0_28px_-10px_rgba(111,191,139,0.55)]",
  warn: "group-hover:shadow-[0_0_28px_-10px_rgba(242,166,90,0.55)]",
  bad: "group-hover:shadow-[0_0_28px_-10px_rgba(226,105,79,0.55)]",
};

export default function KPICard({ label, value, unit, code, tone = "default" }: KPICardProps) {
  return (
    <div
      className={`group blueprint-frame card-lift rounded-lg bg-blueprint-800/30 border hairline p-4 transition-shadow duration-500 ${TONE_GLOW[tone]}`}
    >
      <div className="flex items-start justify-between">
        <span className="font-mono text-[9px] tracking-[0.14em] text-blueprint-line/55">{code}</span>
      </div>
      <div className={`font-display text-[30px] leading-none mt-2.5 tracking-tight ${TONE_COLOR[tone]}`}>
        {value}
        {unit && <span className="text-sm ml-1 text-paper/40">{unit}</span>}
      </div>
      <div className="font-mono text-[10px] text-paper/50 mt-2 uppercase tracking-[0.1em]">
        {label}
      </div>
    </div>
  );
}
