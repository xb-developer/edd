import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // Points every test at dedicated local substitutes — never the dev
    // database/bucket/queue. Set here, not in a .env file, so it's applied
    // before any test file's own imports evaluate a module-level env read
    // (pool.ts's resolveConnectionString(), s3.ts's/documents.ts's
    // module-load-time checks, etc.).
    env: {
      // Dummy values — auth.ts's jwtAuth() only builds a middleware config
      // at module load (JWKS fetch happens lazily on first real request);
      // every route test here injects req.eddContext directly and never
      // exercises requireValidToken itself, so these just need to be
      // non-empty, not real.
      AUTH0_ISSUER_BASE_URL: "https://test.example.com/",
      AUTH0_AUDIENCE: "https://api.test.example.com",
      DATABASE_URL: "postgres://edd_workbench_app:devpassword@localhost:5432/edd_workbench_test",
      S3_ENDPOINT: "http://localhost:9000",
      DOCUMENTS_BUCKET: "edd-workbench-documents-test",
      SQS_ENDPOINT: "http://localhost:9324",
      EDD_WORKBENCH_INGEST_QUEUE_URL: "http://localhost:9324/queue/edd-workbench-ingest-test",
      EDD_WORKBENCH_EXPORT_QUEUE_URL: "http://localhost:9324/queue/edd-workbench-export-test",
      EDD_WORKBENCH_OCR_QUEUE_URL: "http://localhost:9324/queue/edd-workbench-ocr-test",
      EDD_WORKBENCH_EMBEDDING_QUEUE_URL: "http://localhost:9324/queue/edd-workbench-embedding-test",
    },
    testTimeout: 15000,
    // Every test file shares the same real local Postgres/MinIO/ElasticMQ —
    // not per-file isolated instances. Found this out the hard way: two
    // files both legitimately using the one queue the real route code
    // enqueues to (documents.test.ts's upload-complete test and
    // e2e-ingest-pipeline.test.ts) intermittently stole or purged each
    // other's messages when Vitest ran them as parallel files — a genuine
    // flaky-test bug, not a fluke. The suite is small/fast enough that
    // serializing file execution costs nothing and removes this whole class
    // of races for every current and future test, not just this one pair.
    fileParallelism: false,
  },
});
