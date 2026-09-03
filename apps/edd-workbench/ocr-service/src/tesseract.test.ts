import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PutObjectCommand, CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { s3Client, DOCUMENTS_BUCKET } from "@xbundle/edd-workbench-core";
import { extractTextViaOcr } from "./tesseract.js";

// Real fixtures, real Tesseract/poppler binaries, real MinIO — no mocking
// of any kind, matching this repo's stated test philosophy (see
// ONBOARDING.md). There's no AWS client left to mock anyway: the whole
// point of this module is that OCR happens on this machine, not by
// calling out to a service whose SDK client could stand in for it.
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const FIXTURE_PNG = readFileSync(join(FIXTURES_DIR, "scan.png")); // synthetic — see __fixtures__/NOTICE.md
const FIXTURE_PDF = readFileSync(join(FIXTURES_DIR, "scan.pdf")); // synthetic, image-only (no real text layer) — see __fixtures__/NOTICE.md
const FIXTURE_PDF_2PAGE = readFileSync(join(FIXTURES_DIR, "scan-2page.pdf")); // synthetic, image-only — see __fixtures__/NOTICE.md

async function ensureBucket(): Promise<void> {
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: DOCUMENTS_BUCKET }));
  } catch {
    await s3Client.send(new CreateBucketCommand({ Bucket: DOCUMENTS_BUCKET }));
  }
}

async function putFixture(body: Buffer): Promise<string> {
  await ensureBucket();
  const key = `tenants/test/ocr/${randomUUID()}`;
  await s3Client.send(new PutObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: key, Body: body }));
  return key;
}

describe("extractTextViaOcr", () => {
  it("OCRs a plain raster image directly, no rasterization step needed", async () => {
    const key = await putFixture(FIXTURE_PNG);
    const text = await extractTextViaOcr({ bucket: DOCUMENTS_BUCKET, key });
    expect(text).toContain("OCR REGRESSION TEST 482915");
  });

  it("rasterizes a single-page image-only pdf via pdftoppm before OCRing it", async () => {
    const key = await putFixture(FIXTURE_PDF);
    const text = await extractTextViaOcr({ bucket: DOCUMENTS_BUCKET, key });
    expect(text).toContain("OCR REGRESSION TEST 482915");
  });

  it("OCRs every page of a multi-page pdf and joins them in page order", async () => {
    const key = await putFixture(FIXTURE_PDF_2PAGE);
    const text = await extractTextViaOcr({ bucket: DOCUMENTS_BUCKET, key });
    expect(text).toContain("PAGE ONE ALPHA BRAVO");
    expect(text).toContain("PAGE TWO CHARLIE DELTA");
    expect(text.indexOf("PAGE ONE")).toBeLessThan(text.indexOf("PAGE TWO"));
  });

  it("rejects with tesseract's own error output when the S3 object isn't a real image", async () => {
    const key = await putFixture(Buffer.from("this is not an image"));
    await expect(extractTextViaOcr({ bucket: DOCUMENTS_BUCKET, key })).rejects.toThrow();
  });
});
