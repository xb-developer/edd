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
# OCR runs entirely in this container via the real Tesseract engine (not
# tesseract.js's WASM build) — tesseract-ocr is the engine + English
# trained data, poppler-utils supplies pdftoppm to rasterize PDF pages
# into images first (Tesseract only reads raster images, not PDFs). See
# tesseract.ts for the only code that shells out to these.
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr poppler-utils \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps/edd-workbench/ocr-service ./apps/edd-workbench/ocr-service
ENV NODE_ENV=production
EXPOSE 4440
# Runs the TS source directly via tsx, same reasoning as the server/worker
# Dockerfiles: @xbundle/edd-workbench-core's package.json "main" points at
# raw src/index.ts, which plain `node` cannot import.
CMD ["node_modules/.bin/tsx", "apps/edd-workbench/ocr-service/src/index.ts"]
