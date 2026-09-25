# Hugging Face Space image: the whole stack (Postgres/PostGIS, Redis, FastAPI,
# Celery, Next.js, nginx) in one container, fronted by nginx on port 7860.
FROM node:20-bookworm-slim AS nodesrc

FROM python:3.11-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    postgresql postgresql-15-postgis-3 redis-server nginx supervisor \
    libpq-dev gcc \
    && rm -rf /var/lib/apt/lists/*

COPY --from=nodesrc /usr/local/bin/node /usr/local/bin/node
COPY --from=nodesrc /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm

RUN useradd -m -u 1000 user
ENV PATH="/usr/lib/postgresql/15/bin:$PATH"
WORKDIR /home/user/app

COPY --chown=user backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY --chown=user frontend frontend
# The API is served same-origin (nginx routes /api, /ws, /health, /docs to
# FastAPI). The demo password is baked in so the public demo's one-click
# sign-in works; it only unlocks the seeded mock-data accounts.
ARG SPACE_URL=https://elisha622-smartcity-ai.hf.space
ENV NEXT_PUBLIC_API_URL=${SPACE_URL} \
    NEXT_PUBLIC_DEMO_PASSWORD=demo
RUN cd frontend && npm install && npm run build

COPY --chown=user backend/app backend/app
COPY --chown=user hf hf
RUN chmod +x hf/entrypoint.sh && chown -R user:user /home/user

USER user
ENV SMARTCITY_POSTGRES_URL=postgresql://smartcity:smartcity@127.0.0.1:5432/smartcity \
    SMARTCITY_REDIS_URL=redis://127.0.0.1:6379/0 \
    SMARTCITY_MODEL_MODE=mock \
    PYTHONUNBUFFERED=1
EXPOSE 7860
CMD ["/home/user/app/hf/entrypoint.sh"]
