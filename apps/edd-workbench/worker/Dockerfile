# See apps/edd-workbench/server/Dockerfile for why the build context is the
# monorepo root, and why this runs via tsx rather than a compiled dist/.
FROM node:22-slim AS build
WORKDIR /repo
COPY . .
RUN npm install

FROM node:22-slim
WORKDIR /repo
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps/edd-workbench/worker ./apps/edd-workbench/worker
ENV NODE_ENV=production
CMD ["node_modules/.bin/tsx", "apps/edd-workbench/worker/src/index.ts"]
