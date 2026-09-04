import { describe, expect, it } from "vitest";
import { sortDocuments } from "./sortDocuments.js";
import type { DocumentDTO } from "./types.js";

function doc(overrides: Partial<DocumentDTO>): DocumentDTO {
  return {
    documentId: overrides.documentId ?? Math.random().toString(36),
    guid: "000000",
    familyGuid: "000000",
    parentGuid: null,
    depth: 0,
    originalFilename: "file.txt",
    extension: "txt",
    sizeBytes: 0,
    fileModifiedAt: null,
    contentTypeDetected: "text",
    ingestStatus: "ready",
    ingestError: null,
    ocrStatus: "excluded",
    title: null,
    author: null,
    subject: null,
    docDate: null,
    contentModifiedAt: null,
    toAddresses: null,
    ccAddresses: null,
    metadata: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("sortDocuments", () => {
  it("sorts zero-padded GUID strings numerically ascending and descending", () => {
    const docs = [doc({ guid: "000042" }), doc({ guid: "000003" }), doc({ guid: "000017" })];

    expect(sortDocuments(docs, "guid", "asc").map((d) => d.guid)).toEqual(["000003", "000017", "000042"]);
    expect(sortDocuments(docs, "guid", "desc").map((d) => d.guid)).toEqual(["000042", "000017", "000003"]);
  });

  it("sorts sizeBytes numerically, not lexically (100 must not sort before 20)", () => {
    const docs = [doc({ sizeBytes: 100 }), doc({ sizeBytes: 20 }), doc({ sizeBytes: 5 })];

    expect(sortDocuments(docs, "sizeBytes", "asc").map((d) => d.sizeBytes)).toEqual([5, 20, 100]);
    expect(sortDocuments(docs, "sizeBytes", "desc").map((d) => d.sizeBytes)).toEqual([100, 20, 5]);
  });

  it("sorts originalFilename as a case-sensible string", () => {
    const docs = [doc({ originalFilename: "banana.txt" }), doc({ originalFilename: "Apple.txt" }), doc({ originalFilename: "cherry.txt" })];

    expect(sortDocuments(docs, "originalFilename", "asc").map((d) => d.originalFilename)).toEqual(["Apple.txt", "banana.txt", "cherry.txt"]);
  });

  it("sorts ISO date strings chronologically", () => {
    const docs = [
      doc({ docDate: "2026-03-01T00:00:00.000Z" }),
      doc({ docDate: "2026-01-15T00:00:00.000Z" }),
      doc({ docDate: "2026-02-10T00:00:00.000Z" }),
    ];

    expect(sortDocuments(docs, "docDate", "asc").map((d) => d.docDate)).toEqual([
      "2026-01-15T00:00:00.000Z",
      "2026-02-10T00:00:00.000Z",
      "2026-03-01T00:00:00.000Z",
    ]);
  });

  it("always sorts a null value to the end, in BOTH directions", () => {
    const withDate = doc({ documentId: "has-date", docDate: "2026-01-01T00:00:00.000Z" });
    const withoutDate = doc({ documentId: "no-date", docDate: null });
    const docs = [withoutDate, withDate];

    expect(sortDocuments(docs, "docDate", "asc").map((d) => d.documentId)).toEqual(["has-date", "no-date"]);
    expect(sortDocuments(docs, "docDate", "desc").map((d) => d.documentId)).toEqual(["has-date", "no-date"]);
  });

  it("does not mutate the original array", () => {
    const docs = [doc({ guid: "000002" }), doc({ guid: "000001" })];
    const original = [...docs];

    sortDocuments(docs, "guid", "asc");

    expect(docs).toEqual(original);
  });
});
