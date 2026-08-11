# Build context is the monorepo root (see infra/edd-workbench/lib/edd-workbench-stack.ts's
# ContainerImage.fromAsset `file` prop) — this workspace depends on sibling
# packages (@xbundle/edd-workbench-core) via npm workspaces symlinks, not
# published packages, so npm install needs the whole tree, not just this dir.
FROM node:22-slim AS build
WORKDIR /repo
COPY . .
RUN npm install

FROM node:22-slim
WORKDIR /repo
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps/edd-workbench/server ./apps/edd-workbench/server
ENV NODE_ENV=production
EXPOSE 4430
# Runs the TS source directly via tsx (already present — devDependencies
# aren't pruned above), not `node dist/index.js` — @xbundle/edd-workbench-core's
# package.json "main" points at raw src/index.ts, which plain `node` cannot
# import at all. This also serves as the migration task's image (see the CDK
# stack's MigrateTaskDefinition), which overrides this command with its own.
CMD ["node_modules/.bin/tsx", "apps/edd-workbench/server/src/index.ts"]
