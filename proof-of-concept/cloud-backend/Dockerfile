# Multi-stage build for the Cloud Backend (Section 8.1/9.1) — one Dockerfile,
# two targets (`api` and `worker`) sharing the same build output, since
# they're the same codebase with different entrypoints
# (src/index.ts vs src/worker.ts). Build with:
#   docker build --target api    -t edd-workbench-api    -f cloud-backend/Dockerfile .
#   docker build --target worker -t edd-workbench-worker -f cloud-backend/Dockerfile .
# Run from the MONOREPO ROOT (the trailing "." above), not from cloud-backend/
# — the workspace install needs the root package.json + lockfile.

# ---------- deps: production-only install, what actually ships ----------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY cloud-backend/package.json cloud-backend/package.json
RUN npm ci --workspace=cloud-backend --omit=dev

# ---------- build: full install (needs devDeps for tsc) + compile ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY cloud-backend/package.json cloud-backend/package.json
RUN npm ci --workspace=cloud-backend
COPY tsconfig.json ./
COPY cloud-backend/tsconfig.json cloud-backend/tsconfig.json
COPY cloud-backend/src cloud-backend/src
RUN npm run build --workspace cloud-backend

# ---------- shared runtime base ----------
FROM node:22-alpine AS runtime-base
WORKDIR /app
ENV NODE_ENV=production
# npm workspaces hoists most cloud-backend deps to the root node_modules,
# but not all of them — the lockfile nests at least one (pdfjs-dist) inside
# cloud-backend/node_modules directly. Both copies are required; missing
# the second one is a silent runtime failure, not a build-time error (found
# by testing the actual install locally, not assumed).
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/cloud-backend/node_modules ./cloud-backend/node_modules
COPY --from=build /app/cloud-backend/dist ./cloud-backend/dist
COPY cloud-backend/package.json ./cloud-backend/package.json
# dist/db/migrate.js resolves its SQL files relative to itself
# (../../migrations from cloud-backend/dist/db/) - needed here so a one-off
# `node dist/db/migrate.js` run (e.g. via `aws ecs run-task` with a command
# override) can actually find the .sql files, not just compile cleanly.
COPY cloud-backend/migrations ./cloud-backend/migrations
WORKDIR /app/cloud-backend
USER node

# ---------- api ----------
FROM runtime-base AS api
EXPOSE 4520
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://localhost:4520/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]

# ---------- worker ----------
FROM runtime-base AS worker
CMD ["node", "dist/worker.js"]
