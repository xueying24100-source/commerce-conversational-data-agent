FROM node:22.19.0-bookworm-slim AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM node:22.19.0-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ENV COMMERCE_SECURITY_HSTS=1
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN COMMERCE_STANDALONE_BUILD=1 npm run build

FROM node:22.19.0-bookworm-slim AS runner
WORKDIR /app
ARG COMMERCE_RELEASE_REVISION=unversioned
LABEL org.opencontainers.image.title="commerce-data-agent" \
  org.opencontainers.image.revision="${COMMERCE_RELEASE_REVISION}"
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV COMMERCE_RELEASE_REVISION=${COMMERCE_RELEASE_REVISION}

RUN groupadd --system --gid 1001 commerce \
  && useradd --system --uid 1001 --gid commerce commerce

COPY --from=builder --chown=commerce:commerce /app/.next/standalone ./
COPY --from=builder --chown=commerce:commerce /app/.next/static ./.next/static
COPY --from=builder --chown=commerce:commerce /app/.next/commerce-worker ./.next/commerce-worker
COPY --from=builder --chown=commerce:commerce /app/public ./public
COPY --from=builder --chown=commerce:commerce /app/scripts/db ./scripts/db
COPY --from=builder --chown=commerce:commerce /app/scripts/connectors ./scripts/connectors
COPY --from=builder --chown=commerce:commerce /app/scripts/runtime ./scripts/runtime
COPY --from=builder --chown=commerce:commerce /app/config/commerce-connector.example.json ./config/commerce-connector.example.json
COPY --from=builder --chown=commerce:commerce /app/migrations ./migrations

USER commerce
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "scripts/runtime/start-commerce.js"]
