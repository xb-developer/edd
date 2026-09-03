import { GetObjectCommand } from "@aws-sdk/client-s3";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { s3Client } from "@xbundle/edd-workbench-core";

const execFileAsync = promisify(execFile);

// Exported so tests can override it — a real multi-page OCR job can
// legitimately take a while, but tests need this short enough that an
// actually-hung process doesn't stall the suite.
export const OCR_TIMEOUT_MS = 5 * 60 * 1000;
// 300 DPI matches what Textract/most OCR pipelines rasterize scanned
// documents at by default — enough resolution for Tesseract's accuracy
// without the memory/time cost of going higher.
const RASTER_DPI = 300;

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function looksLikePdf(buffer: Buffer): boolean {
  return buffer.subarray(0, 5).toString("latin1") === "%PDF-";
}

// pdftoppm names each page "<prefix>-<n>.png", left-padding <n> with zeros
// once the document has more than 9 pages (so a plain string sort already
// sorts correctly) — extracting the number explicitly is just belt-and-
// suspenders against relying on that padding behavior.
function pageNumber(filename: string): number {
  const match = filename.match(/-(\d+)\.png$/);
  return match ? Number(match[1]) : 0;
}

async function rasterizePdf(pdfPath: string, workDir: string): Promise<string[]> {
  const prefix = join(workDir, "page");
  await execFileAsync("pdftoppm", ["-r", String(RASTER_DPI), "-png", pdfPath, prefix], { timeout: OCR_TIMEOUT_MS });
  const files = (await readdir(workDir)).filter((name) => name.startsWith("page") && name.endsWith(".png"));
  if (files.length === 0) throw new Error(`pdftoppm produced no page images for ${pdfPath}`);
  files.sort((a, b) => pageNumber(a) - pageNumber(b));
  return files.map((name) => join(workDir, name));
}

async function runTesseract(imagePath: string): Promise<string> {
  try {
    // "stdout" as the output base tells tesseract to print recognized text
    // to stdout instead of writing a <base>.txt file — no output file to
    // clean up, and the text is already what execFile hands back.
    const { stdout } = await execFileAsync("tesseract", [imagePath, "stdout", "-l", "eng"], { timeout: OCR_TIMEOUT_MS });
    return stdout.trim();
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr;
    throw new Error(stderr?.trim() || (err instanceof Error ? err.message : String(err)));
  }
}

/**
 * Runs OCR entirely on this machine via the native Tesseract engine (see
 * Dockerfile — apt-get installs tesseract-ocr + poppler-utils into this
 * same container image), not the WASM build (tesseract.js): a real binary
 * is meaningfully faster/more accurate, and this service already controls
 * its own image, unlike the Electron app's cross-platform desktop install.
 * No external OCR API call of any kind — the only network I/O here is the
 * S3 GetObject to pull the document onto this machine first.
 *
 * This is the ENTIRE surface OCR-engine-specific code touches — everything
 * else (the REST route, the queue handler) only ever calls this one
 * function, same contract extractTextViaTextract used to have.
 *
 * Tesseract only reads raster images (leptonica formats: png/jpg/tiff/
 * bmp/...), not PDFs directly — a pdf gets rasterized page-by-page first
 * via poppler's pdftoppm before each page image is OCR'd in turn. A
 * multi-page TIFF is handed to tesseract as-is; it walks every page of a
 * TIFF itself in one call, no separate rasterization needed.
 */
export async function extractTextViaOcr(params: { bucket: string; key: string }): Promise<string> {
  const object = await s3Client.send(new GetObjectCommand({ Bucket: params.bucket, Key: params.key }));
  const buffer = await streamToBuffer(object.Body as Readable);

  const workDir = await mkdtemp(join(tmpdir(), "edd-ocr-"));
  try {
    const inputPath = join(workDir, "input");
    await writeFile(inputPath, buffer);

    const imagePaths = looksLikePdf(buffer) ? await rasterizePdf(inputPath, workDir) : [inputPath];

    const pageTexts: string[] = [];
    for (const imagePath of imagePaths) {
      pageTexts.push(await runTesseract(imagePath));
    }
    return pageTexts.join("\n\n").trim();
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
