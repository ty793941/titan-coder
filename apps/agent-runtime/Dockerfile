FROM node:22-bookworm-slim AS codex
RUN npm install --global --ignore-scripts --omit=dev --fetch-timeout=20000 --fetch-retries=1 @openai/codex@0.172.0 \
    && codex --version

FROM node:22-bookworm-slim AS build
WORKDIR /build
RUN npm install --global --ignore-scripts --fetch-timeout=20000 --fetch-retries=1 pnpm@10.34.5 typescript@5.9.3
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages/contracts ./packages/contracts
COPY packages/daemon-protocol ./packages/daemon-protocol
COPY packages/agent-core ./packages/agent-core
COPY apps/agent-runtime ./apps/agent-runtime
RUN pnpm --filter @titan/agent-runtime... install --frozen-lockfile --ignore-scripts --fetch-timeout=20000 --fetch-retries=1
RUN pnpm --filter @titan/agent-runtime... build \
    && pnpm --filter @titan/agent-runtime deploy --legacy --prod /runtime \
    && test -f /runtime/dist/container-worker.js

FROM node:22-bookworm-slim AS worker
WORKDIR /opt/titan
COPY --from=build /runtime ./apps/agent-runtime
ENV HOME=/tmp/titan-home
ENV CODEX_HOME=/tmp/titan-home/.codex
USER node
RUN node --input-type=module -e "await import('./apps/agent-runtime/dist/container-worker.js')"
ENTRYPOINT ["node", "/opt/titan/apps/agent-runtime/dist/container-worker.js"]

FROM worker AS runtime
USER root
COPY --from=codex /usr/local/lib/node_modules/@openai /usr/local/lib/node_modules/@openai
RUN ln -s ../lib/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex
USER node
RUN codex --version
