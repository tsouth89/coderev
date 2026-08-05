/**
 * Find-then-refute review pipeline.
 *
 * The point is precision, not coverage. A cheap model will generate
 * plausible-and-wrong findings all day; a reviewer that reports five issues per
 * PR and is wrong on four trains everyone to ignore it, which is worse than
 * having no reviewer at all. So findings are generated once and then put to a
 * panel of independent skeptics, each asked to *refute* rather than confirm.
 * Only findings a majority fails to refute survive.
 *
 * That is deliberately token-hungry. Tokens are the cheap part; a reviewer
 * nobody trusts is not.
 *
 * The panel is sampled at a non-zero temperature on purpose. Independence is
 * what makes a majority vote mean anything — three votes at temperature 0 are
 * one opinion counted three times.
 */
import {
  addUsage,
  EMPTY_USAGE,
  requestCompletion,
  type ResolvedReviewProvider,
  type TokenUsage,
} from "./provider.ts";

/**
 * Diffs are truncated rather than chunked.
 *
 * A 200k-line refactor is not something a cheap model reviews usefully, and
 * silently splitting it into windows produces findings with no cross-file
 * context while costing the most tokens. Truncating and saying so in the
 * comment is the honest failure mode.
 */
export const MAX_DIFF_CHARACTERS = 240_000;

/** Votes per finding. Odd, so a majority always exists. */
export const REFUTATION_PANEL_SIZE = 3;

/** How many refutation panels run at once. Bounded to stay under rate limits. */
const PANEL_CONCURRENCY = 4;

/** Zero for generation (reproducible), non-zero for the panel (independent). */
const FIND_TEMPERATURE = 0;
const REFUTE_TEMPERATURE = 1;

export interface ReviewFinding {
  readonly file: string;
  readonly line: number;
  readonly title: string;
  readonly detail: string;
}

export interface RefutationVerdict {
  readonly refuted: boolean;
  readonly reason: string;
}

export const FIND_SYSTEM_PROMPT = [
  "You are a senior engineer reviewing a pull request diff.",
  "",
  "Report only defects a senior engineer would stop the merge for: incorrect logic,",
  "data loss, race conditions, resource leaks, security holes, broken error handling,",
  "and violations of the repository conventions you are given.",
  "",
  "Do NOT report any of the following. They are noise, and reporting them makes the",
  "whole review worth less than saying nothing:",
  "- Anything a linter, type checker, formatter, or compiler would catch.",
  "- Missing tests, missing docs, or general code-quality observations.",
  "- Pre-existing issues on lines the diff does not modify.",
  "- Style preferences not stated in the repository conventions.",
  "- Speculation about code you cannot see in the diff.",
  "- Changes that are plainly intentional and central to the stated purpose.",
  "",
  "It is correct and expected to return an empty list. Most pull requests contain",
  "no defect worth blocking.",
  "",
  'Respond with JSON only: {"findings":[{"file":"path","line":123,"title":"one line",',
  '"detail":"two or three sentences naming the concrete failure"}]}',
].join("\n");

export const REFUTE_SYSTEM_PROMPT = [
  "You are refuting a claimed code-review finding. Your job is to show it is WRONG,",
  "not to confirm it. Assume it is wrong until the diff proves otherwise.",
  "",
  "Refute the finding if any of these hold:",
  "- The described failure cannot actually occur given the code in the diff.",
  "- The claim depends on code that is not shown, so it is unverifiable.",
  "- The issue pre-exists on lines the diff does not modify.",
  "- It is a nitpick, a style preference, or something CI already catches.",
  "- The reasoning is plausible but the specific mechanism described is inaccurate.",
  "",
  "If you are uncertain, refute it. A missed defect costs one bug; a false report",
  "costs the reviewer's credibility.",
  "",
  'Respond with JSON only: {"refuted":true|false,"reason":"one sentence"}',
].join("\n");

export function buildFindPrompt(input: {
  readonly diff: string;
  readonly conventions: string | null;
}): string {
  const conventions = input.conventions ? `Repository conventions:\n\n${input.conventions}\n\n` : "";
  return `${conventions}Review this diff.\n\n\`\`\`diff\n${input.diff}\n\`\`\``;
}

export function buildRefutePrompt(input: {
  readonly finding: ReviewFinding;
  readonly diff: string;
}): string {
  return [
    `Claimed finding in ${input.finding.file} at line ${input.finding.line}:`,
    input.finding.title,
    input.finding.detail,
    "",
    "The diff under review:",
    "```diff",
    input.diff,
    "```",
  ].join("\n");
}

/**
 * Pull a JSON object out of a model response.
 *
 * Models wrap JSON in prose or code fences even when told not to, and a
 * reviewer that throws away a whole run over a stray fence is not worth
 * running. Falls back to the outermost brace pair.
 */
export function extractJsonObject(raw: string): unknown {
  const withoutFences = raw.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "");
  const trimmed = withoutFences.trim();
  const candidates = [trimmed];

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(trimmed.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

/** Parse findings leniently; anything malformed is dropped rather than guessed at. */
export function parseFindings(raw: string): ReadonlyArray<ReviewFinding> {
  const parsed = extractJsonObject(raw);
  if (typeof parsed !== "object" || parsed === null) return [];
  const list = (parsed as Record<string, unknown>).findings;
  if (!Array.isArray(list)) return [];

  const findings: Array<ReviewFinding> = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const file = typeof record.file === "string" ? record.file.trim() : "";
    const title = typeof record.title === "string" ? record.title.trim() : "";
    if (file.length === 0 || title.length === 0) continue;

    findings.push({
      file,
      line: typeof record.line === "number" && Number.isFinite(record.line) ? record.line : 0,
      title,
      detail: typeof record.detail === "string" ? record.detail.trim() : "",
    });
  }
  return findings;
}

/**
 * Parse one panel vote.
 *
 * An unreadable vote counts as a refusal to clear the finding, matching the
 * instruction the skeptic was given. Treating it as "not refuted" would let a
 * malformed response promote a finding nobody actually vouched for.
 */
export function parseVerdict(raw: string): RefutationVerdict {
  const parsed = extractJsonObject(raw);
  if (typeof parsed !== "object" || parsed === null) {
    return { refuted: true, reason: "unparseable verdict" };
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.refuted !== "boolean") {
    return { refuted: true, reason: "verdict omitted the refuted field" };
  }
  return {
    refuted: record.refuted,
    reason: typeof record.reason === "string" ? record.reason.trim() : "",
  };
}

/** A finding survives only if fewer than half the panel refuted it. */
export function survivesPanel(verdicts: ReadonlyArray<RefutationVerdict>): boolean {
  if (verdicts.length === 0) return false;
  const refutedCount = verdicts.filter((verdict) => verdict.refuted).length;
  return refutedCount * 2 <= verdicts.length - 1;
}

export function truncateDiff(
  diff: string,
  limit: number = MAX_DIFF_CHARACTERS,
): { readonly diff: string; readonly truncated: boolean } {
  if (diff.length <= limit) return { diff, truncated: false };
  return { diff: diff.slice(0, limit), truncated: true };
}

export const REVIEW_COMMENT_MARKER = "<!-- coderev -->";

export function formatReviewComment(input: {
  readonly findings: ReadonlyArray<ReviewFinding>;
  readonly model: string;
  readonly truncated: boolean;
}): string {
  const lines = [REVIEW_COMMENT_MARKER, "", "### Automated review", ""];

  if (input.findings.length === 0) {
    lines.push("No blocking issues found.");
  } else {
    const noun = input.findings.length === 1 ? "issue" : "issues";
    lines.push(`Found ${input.findings.length} ${noun}:`, "");
    input.findings.forEach((finding, index) => {
      lines.push(`${index + 1}. **${finding.title}**`, "");
      lines.push(`   \`${finding.file}\`${finding.line > 0 ? `:${finding.line}` : ""}`, "");
      if (finding.detail.length > 0) lines.push(`   ${finding.detail}`, "");
    });
  }

  if (input.truncated) {
    lines.push("", "_The diff exceeded the review size limit and was truncated._");
  }
  lines.push(
    "",
    `<sub>Advisory. Generated by \`${input.model}\` and filtered through a ${REFUTATION_PANEL_SIZE}-vote refutation panel.</sub>`,
  );
  return lines.join("\n");
}

/** Run `tasks` with a bounded number in flight, preserving input order. */
async function mapWithConcurrency<A, B>(
  items: ReadonlyArray<A>,
  limit: number,
  run: (item: A) => Promise<B>,
): Promise<Array<B>> {
  const results = new Array<B>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      const item = items[index];
      if (index >= items.length || item === undefined) return;
      results[index] = await run(item);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface AdjudicatedFinding {
  readonly finding: ReviewFinding;
  readonly survived: boolean;
  readonly verdicts: ReadonlyArray<RefutationVerdict>;
  readonly usage: TokenUsage;
}

async function adjudicate(input: {
  readonly finding: ReviewFinding;
  readonly diff: string;
  readonly provider: ResolvedReviewProvider;
}): Promise<AdjudicatedFinding> {
  const prompt = buildRefutePrompt({ finding: input.finding, diff: input.diff });
  const votes = await Promise.all(
    Array.from({ length: REFUTATION_PANEL_SIZE }, async () => {
      try {
        const result = await requestCompletion({
          provider: input.provider,
          systemPrompt: REFUTE_SYSTEM_PROMPT,
          userPrompt: prompt,
          temperature: REFUTE_TEMPERATURE,
        });
        return { verdict: parseVerdict(result.content), usage: result.usage };
      } catch {
        // A panel member that errors out must not silently clear the finding.
        return {
          verdict: { refuted: true, reason: "vote failed" } satisfies RefutationVerdict,
          usage: EMPTY_USAGE,
        };
      }
    }),
  );

  const verdicts = votes.map((vote) => vote.verdict);
  // Seeded as reported:true so that `reported` stays a plain AND across the
  // panel; seeding from EMPTY_USAGE would mark every panel unreported.
  const seed: TokenUsage = { ...EMPTY_USAGE, reported: true };
  return {
    finding: input.finding,
    survived: survivesPanel(verdicts),
    verdicts,
    usage: votes.reduce<TokenUsage>((total, vote) => addUsage(total, vote.usage), seed),
  };
}

export interface DiffReviewResult {
  readonly candidates: ReadonlyArray<ReviewFinding>;
  readonly findings: ReadonlyArray<ReviewFinding>;
  readonly adjudicated: ReadonlyArray<AdjudicatedFinding>;
  readonly usage: TokenUsage;
}

/**
 * Review one diff end to end.
 *
 * Takes a diff rather than a PR number so the benchmark can drive the identical
 * pipeline over recorded diffs. Benchmarking a different code path than the one
 * that ships would measure the wrong thing.
 */
export async function reviewDiff(input: {
  readonly diff: string;
  readonly conventions: string | null;
  readonly provider: ResolvedReviewProvider;
  readonly onProgress?: (message: string) => void;
}): Promise<DiffReviewResult> {
  const note = input.onProgress ?? (() => {});

  let found = { content: "", usage: EMPTY_USAGE };
  try {
    found = await requestCompletion({
      provider: input.provider,
      systemPrompt: FIND_SYSTEM_PROMPT,
      userPrompt: buildFindPrompt({ diff: input.diff, conventions: input.conventions }),
      temperature: FIND_TEMPERATURE,
    });
  } catch (cause) {
    note(`Generation failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  const candidates = parseFindings(found.content);
  note(`${candidates.length} candidate finding(s); refuting.`);

  const adjudicated = await mapWithConcurrency(candidates, PANEL_CONCURRENCY, (finding) =>
    adjudicate({ finding, diff: input.diff, provider: input.provider }),
  );

  for (const entry of adjudicated) {
    const refuted = entry.verdicts.filter((verdict) => verdict.refuted).length;
    note(
      `  ${entry.survived ? "KEEP" : "DROP"} (${refuted}/${entry.verdicts.length} refuted) ${entry.finding.title}`,
    );
  }

  return {
    candidates,
    findings: adjudicated.filter((entry) => entry.survived).map((entry) => entry.finding),
    adjudicated,
    usage: adjudicated.reduce((total, entry) => addUsage(total, entry.usage), found.usage),
  };
}
