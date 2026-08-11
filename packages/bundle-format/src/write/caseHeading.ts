/**
 * Content for the case heading block — deliberately just text, no assumed
 * structure (number of claimants/defendants, an optional preamble line,
 * exact claim-number wording), since real bundles vary on all of it. Never
 * hardcode a specific case's heading anywhere downstream: populate this from
 * whatever the user has entered for the current assembly.
 */
export interface CaseHeadingConfig {
  claimNoLabel: string;
  preamble?: string[];
  courtLines: string[];
  claimants: string[];
  claimantsLabel: string;
  vLabel: string;
  defendants: string[];
  defendantsLabel: string;
}
