FROM node:20-bookworm-slim AS build

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
COPY legacy ./legacy
RUN npm run build \
  && npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production \
    LUCEN_WORKBENCH_HOST=0.0.0.0 \
    LUCEN_WORKBENCH_PORT=8787 \
    LUCEN_DATA_DIR=/app/data
WORKDIR /app
RUN groupadd --system lucen \
  && useradd --system --gid lucen --home-dir /app --shell /usr/sbin/nologin lucen \
  && mkdir -p /app/data \
  && chown lucen:lucen /app/data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/legacy ./legacy
COPY package.json lucen-local-proxy.cjs lucen-auth.cjs local-media.cjs ./
USER lucen
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/__health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "lucen-local-proxy.cjs"]
