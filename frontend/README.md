# Frontend — City Operations Console

Next.js 14 (App Router) + TypeScript + Tailwind. Visual language is
"civic blueprint": dark blueprint-blue background, cyan hairline grid,
corner-bracket framing on every panel (like a surveyor's viewfinder),
monospace data readouts — built to read as an instrument panel a
planner/officer trusts, not a generic SaaS dashboard.

## Pages

- `/` — Digital Twin dashboard (Module 6): live map, KPIs, congestion ranking
- `/traffic` — Traffic analysis + hotspot ranking (Modules 1, 4)
- `/complaints` — Citizen complaint submission + triage table (Module 3)
- `/maintenance` — Road damage priority queue (Module 2)
- `/planner` — AI City Planner chat (Module 5)

## Run locally

```bash
npm install
npm run dev
```

Requires the backend running at `NEXT_PUBLIC_API_URL` (defaults to
`http://localhost:8000`).
