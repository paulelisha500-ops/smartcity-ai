# Single-container image: the whole stack (Postgres/PostGIS, Redis, FastAPI,
# Celery, Next.js, nginx) behind nginx on port 7860, for hosts that run one
# container per app. The hosted edition does not use it — see docs/DEPLOYMENT.md.
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
# FastAPI). The account password is baked in so one-click sign-in works for
# the built-in role accounts.
ARG PUBLIC_URL=http://localhost:7860
ENV NEXT_PUBLIC_API_URL=${PUBLIC_URL} \
    NEXT_PUBLIC_ACCOUNT_PASSWORD=smartcity
RUN cd frontend && npm install && npm run build

COPY --chown=user backend/app backend/app
COPY --chown=user deploy/container deploy/container
RUN chmod +x deploy/container/entrypoint.sh && chown -R user:user /home/user

USER user
ENV SMARTCITY_POSTGRES_URL=postgresql://smartcity:smartcity@127.0.0.1:5432/smartcity \
    SMARTCITY_REDIS_URL=redis://127.0.0.1:6379/0 \
    SMARTCITY_MODEL_MODE=mock \
    PYTHONUNBUFFERED=1
EXPOSE 7860
CMD ["/home/user/app/deploy/container/entrypoint.sh"]
