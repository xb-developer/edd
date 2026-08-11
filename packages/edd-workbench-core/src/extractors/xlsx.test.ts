import { describe, expect, it } from "vitest";
import * as XLSX from "@e965/xlsx";
import { extractXlsxContent } from "./xlsx.js";

// Real xlsx bytes, built and serialized by the same library extractXlsxContent
// reads with — the same self-round-trip convention office.test.ts uses via
// jszip (generateAsync then loadAsync). No hand-rolled binary format guessing.
function buildFixtureXlsx(
  sheets: { name: string; rows: unknown[][] }[],
  props?: { Title?: string; Author?: string; Subject?: string },
  bookType: XLSX.BookType = "xlsx",
): Buffer {
  const workbook = XLSX.utils.book_new();
  for (const sheet of sheets) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name);
  }
  if (props) workbook.Props = props;
  return XLSX.write(workbook, { type: "buffer", bookType });
}

describe("extractXlsxContent", () => {
  it("extracts rows from every sheet of a real workbook", async () => {
    const buffer = buildFixtureXlsx([
      {
        name: "Custodians",
        rows: [
          ["Name", "Role"],
          ["Jane Reviewer", "Reviewer"],
        ],
      },
      { name: "Notes", rows: [["Draft for review"]] },
    ]);

    const result = await extractXlsxContent(buffer);

    expect(result.sheets).toHaveLength(2);
    expect(result.sheets[0].name).toBe("Custodians");
    expect(result.sheets[0].rows).toEqual([
      ["Name", "Role"],
      ["Jane Reviewer", "Reviewer"],
    ]);
    expect(result.sheets[1].name).toBe("Notes");
    expect(result.sheets[1].rows).toEqual([["Draft for review"]]);
  });

  it("never throws for bytes that aren't a workbook at all — SheetJS itself is lenient and reads them as a degenerate one-cell sheet rather than failing", async () => {
    const result = await extractXlsxContent(Buffer.from("not a workbook"));
    expect(result.sheets).toEqual([{ name: "Sheet1", rows: [["not a workbook"]] }]);
    expect(result.title).toBeNull();
  });

  it("extracts title/author/subject from a real .xlsx workbook's Props", async () => {
    const buffer = buildFixtureXlsx([{ name: "Sheet1", rows: [["a"]] }], {
      Title: "Custodian Log",
      Author: "Jane Reviewer",
      Subject: "Draft for review",
    });

    const result = await extractXlsxContent(buffer);

    expect(result.title).toBe("Custodian Log");
    expect(result.author).toBe("Jane Reviewer");
    expect(result.subject).toBe("Draft for review");
  });

  it("extracts rows and title/author/subject from a real legacy .xls (BIFF8) workbook", async () => {
    const buffer = buildFixtureXlsx(
      [
        {
          name: "Custodians",
          rows: [
            ["Name", "Role"],
            ["Jane Reviewer", "Reviewer"],
          ],
        },
      ],
      { Title: "Custodian Log", Author: "Jane Reviewer" },
      "biff8",
    );

    const result = await extractXlsxContent(buffer);

    expect(result.sheets[0].rows).toEqual([
      ["Name", "Role"],
      ["Jane Reviewer", "Reviewer"],
    ]);
    expect(result.title).toBe("Custodian Log");
    expect(result.author).toBe("Jane Reviewer");
  });

  it("extracts a plain CSV buffer as a single-sheet grid", async () => {
    const csv = Buffer.from("Name,Role\nJane Reviewer,Reviewer\n", "utf-8");
    const result = await extractXlsxContent(csv);

    expect(result.sheets).toHaveLength(1);
    expect(result.sheets[0].rows).toEqual([
      ["Name", "Role"],
      ["Jane Reviewer", "Reviewer"],
    ]);
  });
});
