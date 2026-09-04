/**
 * Heuristic detection of prompt-injection-style content in extracted
 * document text — flags documents whose content tries to instruct the
 * `/ask` feature's generation model directly (see
 * COLLATE_SECURITY_FINDINGS.md Finding 1: a real pentest planted a
 * "[SYSTEM INSTRUCTION - PRIORITY OVERRIDE...]" block in a document's body
 * and got the self-hosted generation model to follow it, prefixing
 * unrelated answers with a planted marker).
 *
 * This is defense-in-depth alongside ask.ts's own prompt-level mitigation
 * (delimiting excerpts as untrusted data, an explicit instruction
 * hierarchy) — not a replacement for it. Live testing against the real
 * generation model, after that prompt-level fix shipped, confirmed a
 * convincingly-worded override still got through in some cases: the
 * self-hosted Qwen3-8B model is far less resistant to in-context
 * instruction hijacking than a larger, more heavily-aligned model would be,
 * and no prompt structure alone reliably closes that gap. Flagging the
 * document at ingest time — before its text ever becomes retrievable
 * context — lets a reviewer see the warning and judge an AI answer that
 * cites it accordingly, rather than trusting it silently.
 *
 * Deliberately a small, named list of fairly distinctive phrases, not a
 * broad/fuzzy "sounds like an instruction" heuristic: a false positive here
 * just costs an extra reviewer warning (cheap), but a pattern list broad
 * enough to catch ordinary legal correspondence ("please disregard our
 * previous letter dated...") would make the warning noise, not signal. Not
 * exhaustive, either — a sufficiently creative attacker can phrase around
 * any fixed pattern list, which is exactly why this is a warning surfaced
 * to a human reviewer, not a silent block or an attempt to sanitize the
 * text itself.
 */
const INJECTION_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "instruction override", pattern: /\b(ignore|disregard)\s+(all\s+)?(the\s+)?(previous|prior)\s+(instructions?|constraints?|prompts?)\b/i },
  { label: "priority override", pattern: /\bpriority\s+override\b/i },
  { label: "fake system-instruction block", pattern: /\bsystem\s+instructions?\s*[-:—]/i },
  { label: "developer prompt reference", pattern: /\bdeveloper\s+(system\s+)?prompt\b/i },
  { label: "forced response prefix", pattern: /\b(your\s+)?(response|answer)\s+must\s+(begin|start)\s+with\b/i },
  { label: "jailbreak phrasing", pattern: /\bjailbreak\b|\bDAN\s+mode\b/i },
];

export interface InjectionCheckResult {
  suspected: boolean;
  /** Short, reviewer-facing description of the first pattern that matched — one hit is enough to warn on, so only the first is reported rather than every pattern the text happens to trip. Null when suspected is false. */
  warning: string | null;
}

export function detectInjectionPatterns(text: string): InjectionCheckResult {
  for (const { label, pattern } of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      return {
        suspected: true,
        warning: `This document's content resembles an AI prompt-injection attempt (${label}) — review before relying on AI-generated answers that cite it.`,
      };
    }
  }
  return { suspected: false, warning: null };
}
