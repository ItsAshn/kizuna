FROM node:22-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/desktop/package.json apps/desktop/
COPY packages/shared/package.json packages/shared/

RUN pnpm install --frozen-lockfile

COPY apps/server/src/ apps/server/src/
COPY apps/server/tsconfig.json apps/server/
COPY packages/shared/src/ packages/shared/src/

RUN pnpm --filter @kizuna/server build

FROM base AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/pnpm-workspace.yaml /app/pnpm-lock.yaml /app/package.json ./
COPY --from=builder /app/apps/server/package.json apps/server/
COPY --from=builder /app/packages/shared/package.json packages/shared/
COPY --from=builder /app/packages/shared/src/ packages/shared/src/

RUN pnpm install --prod --frozen-lockfile

COPY --from=builder /app/apps/server/dist apps/server/dist

RUN groupadd --system kizuna && useradd --system --gid kizuna kizuna
RUN mkdir -p /data && chown kizuna:kizuna /data
ENV SERVER_DB_PATH=/data/server.db
RUN mkdir -p /app/uploads && chown kizuna:kizuna /app/uploads

EXPOSE 5000

USER kizuna

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:5000/health').then(r=>{if(!r.ok)throw 1}).catch(()=>process.exit(1))"

CMD ["node", "apps/server/dist/index.js"]
