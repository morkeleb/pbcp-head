# The head with Chromium, for self-hosting (docker-compose.yml) and for CI, which runs the conformance gate
# inside this same image. Vercel does not use it (docs/deploy.md).
#
#   docker compose up -d                      the head on :3000 with Postgres, migrated on start
#   docker compose run --rm head pnpm test:gate    the test suites and the gate, against the compose Postgres

FROM node:22-bookworm-slim

# Chromium draws mermaid diagrams (lib/render/draw.ts). Debian's build, with fonts for diagram text.
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-dejavu-core ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV PBCP_CHROMIUM_PATH=/usr/bin/chromium \
    # Chromium's own sandbox needs user namespaces, which Docker's default seccomp profile denies; the
    # container is the boundary, and drawing has no network either way (lib/render/draw.ts).
    PBCP_CHROMIUM_NO_SANDBOX=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000

RUN corepack enable
WORKDIR /app
RUN chown node:node /app
USER node

# Dependencies first, for the layer cache. `prepare` builds the vendored @pbcp packages from their source.
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml .puppeteerrc.cjs ./
COPY --chown=node:node vendor ./vendor
RUN pnpm install --frozen-lockfile

COPY --chown=node:node . .
RUN pnpm build

EXPOSE 3000
ENTRYPOINT ["sh", "scripts/docker-entrypoint.sh"]
CMD ["serve"]
