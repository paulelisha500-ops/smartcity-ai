# Frontend — City Operations Console

Next.js 14 (App Router) + TypeScript + Tailwind. Visual language is
"civic blueprint": dark blueprint-blue background, cyan hairline grid,
corner-bracket framing on every panel (like a surveyor's viewfinder),
monospace data readouts — built to read as an instrument panel a
planner/officer trusts, not a generic SaaS dashboard.

## Pages

Public: `/welcome`, `/about`, `/faq`, `/report` (citizen report, no sign-in), `/login`.

Console (signed in; each role sees the modules it is cleared for — see
`src/lib/nav.ts`): `/` Digital Twin, `/traffic`, `/cameras`, `/dispatch`,
`/complaints`, `/maintenance`, `/network`, `/infrastructure`, `/route-design`,
`/planner`, `/analytics`. The root README's module table maps them to modules.

## Run locally

```bash
npm install
npm run dev
```

Requires the backend running at `NEXT_PUBLIC_API_URL` (defaults to
`http://localhost:8001`, where docker-compose publishes it).

The hosted edition — the same app with no server, answering from a published
data set — is built with `npm run build:static`; see `docs/DEPLOYMENT.md`,
which also covers the end-to-end suite (`npm run e2e`).
