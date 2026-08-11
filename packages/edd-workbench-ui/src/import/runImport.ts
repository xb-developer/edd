/**
 * The subset of the browser `File` interface this module actually touches
 * — kept as its own interface (not `import type { File }`) so tests can
 * pass plain objects instead of needing a DOM environment. A real `File`
 * satisfies this structurally with no adapter needed.
 */
export interface UploadableFile {
  name: string;
  size: number;
  type: string;
  lastModified: number;
}

export interface ImportInitResult {
  documentId: string;
  guid: string;
  uploadUrl: string;
}

export interface ImportFailure {
  filename: string;
  error: string;
}

export interface RunImportDeps<F extends UploadableFile> {
  /** How many files upload concurrently. Defaults to 6, matching the POC's own constant. */
  concurrency?: number;
  /** One batched call for the whole file list — mirrors init-upload's real contract (GUID assignment happens as one unit, not per file). Must return one result per input file, in the same order. */
  initUpload: (files: F[]) => Promise<ImportInitResult[]>;
  /** The actual per-file work: PUT the bytes to S3, then call upload-complete. Runs inside the concurrency pool, one file at a time per worker slot. */
  uploadOne: (file: F, init: ImportInitResult) => Promise<void>;
  /** Fires once per file, success or failure, as soon as that file settles — lets the caller update progress/refresh the document list incrementally rather than waiting for the whole batch. */
  onFileSettled?: (file: F, error: string | null) => void;
}

export interface RunImportResult {
  failures: ImportFailure[];
}

/**
 * Orchestrates importing a batch of files: one `initUpload` call for GUID/
 * URL assignment, then a bounded-concurrency pool of `uploadOne` calls (the
 * slow, failure-prone part) — kept as a plain function with every real
 * side effect injected specifically so this logic is unit-testable without
 * a browser or a real S3/API. One file's failure never aborts the others;
 * a failure in `initUpload` itself (the one truly all-or-nothing step)
 * fails every file with the same reason rather than silently returning
 * nothing.
 */
export async function runImport<F extends UploadableFile>(files: F[], deps: RunImportDeps<F>): Promise<RunImportResult> {
  const failures: ImportFailure[] = [];
  if (files.length === 0) return { failures };

  let initResults: ImportInitResult[];
  try {
    initResults = await deps.initUpload(files);
  } catch (err) {
    const message = errorMessage(err);
    for (const file of files) {
      failures.push({ filename: file.name, error: message });
      deps.onFileSettled?.(file, message);
    }
    return { failures };
  }

  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < files.length) {
      const index = nextIndex++;
      const file = files[index];
      try {
        await deps.uploadOne(file, initResults[index]);
        deps.onFileSettled?.(file, null);
      } catch (err) {
        const message = errorMessage(err);
        failures.push({ filename: file.name, error: message });
        deps.onFileSettled?.(file, message);
      }
    }
  }

  const workerCount = Math.min(deps.concurrency ?? 6, files.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return { failures };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
