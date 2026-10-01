# Deployment

SmartCity AI ships in three forms. They run the same frontend and the same
service logic; they differ in where that logic executes.

| Form | What runs | Use it for |
|---|---|---|
| **Hosted edition** | Static site on a Hugging Face Space, no server | The public site |
| **Compose stack** | Postgres/PostGIS, Redis, FastAPI, Celery, Next.js | Development, ingestion, real cameras |
| **Single container** | The compose stack in one image | Hosts that run one container per app |

## Hosted edition

Live at <https://elisha622-smartcity-ai.static.hf.space>
(Space: <https://huggingface.co/spaces/Elisha622/smartcity-ai>).

A static Space serves files and nothing else, so the frontend is built with
`NEXT_PUBLIC_STATIC_API=1`. In that build `frontend/src/lib/api.ts` hands every
request to `frontend/src/lib/static-api.ts` instead of the network, and it
answers in one of three ways:

- **Recorded.** Read endpoints replay the API's own output from `/data`.
- **Computed.** The traffic model, place search, reverse geocoding, complaint
  analysis, the planner and corridor design are ports of the backend services
  (`traffic_cv`, `geocode`, `complaint_nlp`, `rag_planner`, `road_graph`,
  `route_designer`) running in the browser. Corridor design routes with A\*
  over the API's own graph, exported as a compact binary
  (`scripts/export_routing_graph.py`, read by `frontend/src/lib/routing.ts`).
- **Fixed.** Console actions whose outcome the published data set already
  determines — re-seeding a seeded register, probing camera sites that have no
  device yet — replay what the server returns for them.

When a backend service changes, change its port with it. The ports are kept
line-for-line close to the Python so the two can be read side by side, and the
results agree: the browser router returns the same route, time and cost as the
API for the same corridor.

What the hosted edition does not do: persist anything. Reports filed there
live in the browser for the visit. Ingestion, camera probing and anything that
writes to PostGIS need the compose stack.

### How it is published

Two things live in the Space, with different lifetimes.

**The site** is built from source and published by GitHub Actions
(`.github/workflows/deploy.yml`) on every push to `main`. It needs one
repository secret:

```bash
gh secret set HF_TOKEN
```

Paste a Hugging Face access token with write access to the Space when
prompted (create one at <https://huggingface.co/settings/tokens>; a
fine-grained token scoped to this Space and the source mirror is enough).
Without the secret the workflow still builds the site, and says it did not
publish.

**The data set** under `data/` is a snapshot of a database with the network
ingested, which CI does not have. Refresh it from a machine running the
compose stack:

```bash
docker compose up -d postgres redis backend
python scripts/snapshot_static.py        # writes frontend/public/data
cd frontend && npm run build:static && cd ..
python scripts/deploy_space.py --data    # publishes site and data set
```

`snapshot_static.py` takes step names if only part of it needs refreshing
(`actions gets emergency search designs graph tiles`).

### Checking a build locally

```bash
cd frontend
npm run build:static
node scripts/serve-static.mjs            # http://localhost:7861
```

`serve-static.mjs` serves `out/` the way the Space does, quirks included: `/`
redirects to `/index.html`, `/page` resolves to `page.html`, and a script is
injected ahead of every document's doctype. Set `INJECT=0` to serve the
documents untouched when telling a host quirk from a real bug.

## Compose stack

```bash
docker compose up -d --build
```

Frontend on <http://localhost:3001>, API on <http://localhost:8001>. See the
README for first-run ingestion.

## Single container

`Dockerfile` at the repository root builds the whole stack into one image —
Postgres/PostGIS, Redis, the API, the Celery worker and the Next.js server
under supervisord, behind nginx on port 7860 (`deploy/container/`).

```bash
docker build -t smartcity-ai --build-arg PUBLIC_URL=https://your.host .
docker run -p 7860:7860 smartcity-ai
```

`PUBLIC_URL` is the address browsers will reach it on; the frontend is built
against it. The database lives inside the container, so mount a volume at
`/home/user/pgdata` to keep it across restarts. A random JWT secret is
generated at each start unless `SMARTCITY_JWT_SECRET` is set.
