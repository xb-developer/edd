import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import multer from "multer";
import { handleUploadError } from "../src/middleware/uploadError.js";
import { MAX_UPLOAD_BYTES } from "../src/routes/documents.js";

/**
 * A real HTTP round trip, not a call to the middleware function directly —
 * proves the actual wiring (multer throws -> Express routes the error past
 * the route handler -> handleUploadError catches it) produces a clean JSON
 * body, not just that the handler function does the right thing in
 * isolation. Uses a tiny 5-byte limit rather than the real 5GB one so the
 * test doesn't need to actually send gigabytes of data.
 */
async function startTestServer(limitBytes: number) {
  const app = express();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: limitBytes } });
  app.post("/upload", upload.single("file"), (_req, res) => res.status(201).json({ ok: true }));
  app.use(handleUploadError(limitBytes));
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  return { server, port };
}

test("a file exceeding the limit gets a clean 413 JSON body, not a bare HTML error page", async () => {
  const { server, port } = await startTestServer(5);
  try {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(1024)]), "big.bin");
    const res = await fetch(`http://localhost:${port}/upload`, { method: "POST", body: form });

    assert.equal(res.status, 413);
    assert.equal(res.headers.get("content-type")?.includes("application/json"), true);
    const body = await res.json();
    assert.equal(body.error, "file_too_large");
    assert.match(body.detail, /Files are limited to \d+GB/);
  } finally {
    server.close();
  }
});

test("a file within the limit uploads normally, unaffected by the error handler", async () => {
  const { server, port } = await startTestServer(1024);
  try {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(10)]), "small.bin");
    const res = await fetch(`http://localhost:${port}/upload`, { method: "POST", body: form });

    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.ok, true);
  } finally {
    server.close();
  }
});

test("the real upload route's limit matches the documented 5GB ceiling", () => {
  assert.equal(MAX_UPLOAD_BYTES, 5 * 1024 * 1024 * 1024);
});
