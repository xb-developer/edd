import { Router } from "express";
import { db, type CaseHeadingRow } from "../db.js";
import type { CaseHeadingConfig } from "@xbundle/bundle-format";

export const caseHeadingRouter = Router();

interface CaseHeadingDTO {
  claimNoLabel: string;
  preamble: string[];
  courtLines: string[];
  claimants: string[];
  claimantsLabel: string;
  vLabel: string;
  defendants: string[];
  defendantsLabel: string;
}

const DEFAULTS: CaseHeadingDTO = {
  claimNoLabel: "",
  preamble: [],
  courtLines: [],
  claimants: [],
  claimantsLabel: "Claimant",
  vLabel: "-v-",
  defendants: [],
  defendantsLabel: "Defendant",
};

function toLines(value: string): string[] {
  return value
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function rowToDTO(row: CaseHeadingRow | undefined): CaseHeadingDTO {
  if (!row) return DEFAULTS;
  return {
    claimNoLabel: row.claim_no_label,
    preamble: toLines(row.preamble),
    courtLines: toLines(row.court_lines),
    claimants: toLines(row.claimants),
    claimantsLabel: row.claimants_label,
    vLabel: row.v_label,
    defendants: toLines(row.defendants),
    defendantsLabel: row.defendants_label,
  };
}

/** Converts the stored/edited DTO into the shape exportBundle's CaseHeadingConfig expects (preamble omitted entirely when empty, matching that field's optional-array convention). */
export function loadCaseHeadingConfig(): CaseHeadingConfig {
  const row = db.prepare("SELECT * FROM case_heading WHERE id = 1").get() as unknown as CaseHeadingRow | undefined;
  const dto = rowToDTO(row);
  return {
    claimNoLabel: dto.claimNoLabel,
    ...(dto.preamble.length > 0 ? { preamble: dto.preamble } : {}),
    courtLines: dto.courtLines,
    claimants: dto.claimants,
    claimantsLabel: dto.claimantsLabel,
    vLabel: dto.vLabel,
    defendants: dto.defendants,
    defendantsLabel: dto.defendantsLabel,
  };
}

caseHeadingRouter.get("/", (_req, res) => {
  const row = db.prepare("SELECT * FROM case_heading WHERE id = 1").get() as unknown as CaseHeadingRow | undefined;
  res.json(rowToDTO(row));
});

caseHeadingRouter.put("/", (req, res) => {
  const body = req.body as Partial<CaseHeadingDTO>;
  const dto: CaseHeadingDTO = { ...DEFAULTS, ...body };

  db.prepare(
    `INSERT INTO case_heading (id, claim_no_label, preamble, court_lines, claimants, claimants_label, v_label, defendants, defendants_label)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       claim_no_label = excluded.claim_no_label,
       preamble = excluded.preamble,
       court_lines = excluded.court_lines,
       claimants = excluded.claimants,
       claimants_label = excluded.claimants_label,
       v_label = excluded.v_label,
       defendants = excluded.defendants,
       defendants_label = excluded.defendants_label`,
  ).run(
    dto.claimNoLabel,
    dto.preamble.join("\n"),
    dto.courtLines.join("\n"),
    dto.claimants.join("\n"),
    dto.claimantsLabel,
    dto.vLabel,
    dto.defendants.join("\n"),
    dto.defendantsLabel,
  );

  const row = db.prepare("SELECT * FROM case_heading WHERE id = 1").get() as unknown as CaseHeadingRow;
  res.json(rowToDTO(row));
});
