import { describe, expect, it } from "vitest";
import { runImport, type ImportInitResult, type UploadableFile } from "./runImport.js";

function makeFile(name: string, overrides?: Partial<UploadableFile>): UploadableFile {
  return { name, size: 100, type: "text/plain", lastModified: Date.now(), ...overrides };
}

function fakeInitResultsFor(files: UploadableFile[]): ImportInitResult[] {
  return files.map((file, i) => ({ documentId: `doc-${i}`, guid: String(i + 1).padStart(6, "0"), uploadUrl: `https://s3.example/${file.name}` }));
}

describe("runImport", () => {
  it("returns no failures and calls onFileSettled(file, null) for every file when everything succeeds", async () => {
    const files = [makeFile("a.txt"), makeFile("b.txt"), makeFile("c.txt")];
    const settled: { name: string; error: string | null }[] = [];

    const result = await runImport(files, {
      initUpload: async (fs) => fakeInitResultsFor(fs),
      uploadOne: async () => {},
      onFileSettled: (file, error) => settled.push({ name: file.name, error }),
    });

    expect(result.failures).toEqual([]);
    expect(settled).toHaveLength(3);
    expect(settled.every((s) => s.error === null)).toBe(true);
  });

  it("records a per-file failure without aborting the other files in the batch", async () => {
    const files = [makeFile("good1.txt"), makeFile("bad.txt"), makeFile("good2.txt")];
    const succeeded: string[] = [];

    const result = await runImport(files, {
      initUpload: async (fs) => fakeInitResultsFor(fs),
      uploadOne: async (file) => {
        if (file.name === "bad.txt") throw new Error("simulated upload failure");
        succeeded.push(file.name);
      },
    });

    expect(result.failures).toEqual([{ filename: "bad.txt", error: "simulated upload failure" }]);
    expect(succeeded.sort()).toEqual(["good1.txt", "good2.txt"]);
  });

  it("turns a rejected ({ error }) initUpload result straight into a failure, never calling uploadOne for that file", async () => {
    const files = [makeFile("small.txt"), makeFile("huge.txt")];
    const uploadOneCalls: string[] = [];

    const result = await runImport(files, {
      initUpload: async (fs) =>
        fs.map((file, i) =>
          file.name === "huge.txt" ? { error: `"${file.name}" would exceed this matter's 3GB storage quota` } : { documentId: `doc-${i}`, guid: "000001", uploadUrl: `https://s3.example/${file.name}` },
        ),
      uploadOne: async (file) => {
        uploadOneCalls.push(file.name);
      },
    });

    expect(result.failures).toEqual([{ filename: "huge.txt", error: `"huge.txt" would exceed this matter's 3GB storage quota` }]);
    expect(uploadOneCalls).toEqual(["small.txt"]);
  });

  it("fails every file with the same reason when initUpload itself fails, rather than silently returning nothing", async () => {
    const files = [makeFile("a.txt"), makeFile("b.txt")];
    const settled: { name: string; error: string | null }[] = [];

    const result = await runImport(files, {
      initUpload: async () => {
        throw new Error("server unreachable");
      },
      uploadOne: async () => {
        throw new Error("should never be called");
      },
      onFileSettled: (file, error) => settled.push({ name: file.name, error }),
    });

    expect(result.failures).toEqual([
      { filename: "a.txt", error: "server unreachable" },
      { filename: "b.txt", error: "server unreachable" },
    ]);
    expect(settled).toEqual([
      { name: "a.txt", error: "server unreachable" },
      { name: "b.txt", error: "server unreachable" },
    ]);
  });

  it("never calls initUpload at all for an empty file list", async () => {
    let called = false;
    const result = await runImport([], {
      initUpload: async () => {
        called = true;
        return [];
      },
      uploadOne: async () => {},
    });

    expect(called).toBe(false);
    expect(result.failures).toEqual([]);
  });

  it("never runs more concurrent uploads than the configured concurrency, while still running some in parallel", async () => {
    const files = Array.from({ length: 10 }, (_, i) => makeFile(`file-${i}.txt`));
    let concurrent = 0;
    let maxConcurrent = 0;

    await runImport(files, {
      concurrency: 3,
      initUpload: async (fs) => fakeInitResultsFor(fs),
      uploadOne: async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 5));
        concurrent--;
      },
    });

    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(maxConcurrent).toBeGreaterThan(1);
  });

  it("passes each file's own initUpload result (matched by array index) to uploadOne", async () => {
    const files = [makeFile("first.txt"), makeFile("second.txt")];
    const received: Extract<ImportInitResult, { documentId: string }>[] = [];

    await runImport(files, {
      initUpload: async (fs) => fakeInitResultsFor(fs),
      uploadOne: async (_file, init) => {
        received.push(init);
      },
    });

    expect(received.map((r) => r.documentId).sort()).toEqual(["doc-0", "doc-1"]);
  });
});
