import * as CFBReal from "cfb";

// ppt@0.0.2 (SheetJS, 2014) expects an older cfb API where the parsed
// container exposed a `.find(path)` instance method; modern cfb exposes
// `find(container, path)` as a static function instead. ppt.js resolves its
// dependency via an implicit global (`if (typeof CFB === 'undefined') CFB =
// require('cfb')`), so pre-seeding globalThis.CFB with a patched read()
// lets it pick up a compatible shape without touching cfb's real version
// (which `xlsx` depends on separately and is not affected — it vendors its
// own inline CFB reader rather than requiring the shared package).
declare global {
  // eslint-disable-next-line no-var
  var CFB: typeof CFBReal | undefined;
}

if (!globalThis.CFB) {
  globalThis.CFB = {
    ...CFBReal,
    read(...args: Parameters<typeof CFBReal.read>) {
      const container = CFBReal.read(...args);
      const patchable = container as unknown as { find?: (path: string) => unknown };
      if (!patchable.find) patchable.find = (path: string) => CFBReal.find(container, path);
      return container;
    },
  } as typeof CFBReal;
}

interface PptModule {
  readFile(filename: string): unknown;
  utils: { to_text(pres: unknown): string[] };
}

let pptModulePromise: Promise<PptModule> | null = null;
function loadPpt(): Promise<PptModule> {
  if (!pptModulePromise) pptModulePromise = import("ppt").then((m) => (m as { default: PptModule }).default);
  return pptModulePromise;
}

// ppt@0.0.2 is an early cleanroom implementation of the legacy PPT binary
// format — it throws on record types it doesn't recognize rather than
// skipping them gracefully, so it does not parse every real-world .ppt file
// (verified against a real litigation-style corpus: some files extract
// cleanly, others throw on unimplemented master-slide records). Best-effort
// only, same spirit as the scanned-PDF OCR retry — a document this fails on
// registers with no text, exactly like today's baseline for this format.
export async function extractLegacyPpt(filePath: string): Promise<string | null> {
  try {
    const PPT = await loadPpt();
    const pres = PPT.readFile(filePath);
    const text = PPT.utils.to_text(pres).join("\n").trim();
    return text || null;
  } catch (err) {
    console.warn(`Legacy PPT extraction failed for ${filePath}: ${(err as Error).message}`);
    return null;
  }
}
