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
 * A genuinely enormous refactor is not something a cheap model reviews
 * usefully, and silently splitting it into windows produces findings with no
 * cross-file context while costing the most tokens. Truncating and saying so in
 * the comment is the honest failure mode.
 *
 * The limit is generous because the models this targets are not
 * context-constrained: 600k characters is roughly 150k tokens against DeepSeek
 * V4's 1M window. An earlier 240k limit was set by guesswork and would have
 * silently truncated the single richest case in the benchmark suite, which
 * would have quietly corrupted the comparison it exists to produce.
 */
export const MAX_DIFF_CHARACTERS = 600_000;

/** Votes per finding. Odd, so a majority always exists. */
export const REFUTATION_PANEL_SIZE = 3;

/**
 * How many panel votes run at once, after the cache-warming first vote.
 *
 * Sized against the loosened generator rather than the old one. Ten findings
 * means thirty votes, which at four-at-a-time is eight sequential rounds of a
 * reasoning model and would put a ten-PR benchmark past two hours. Eight halves
 * that. Retries cover the rate limiting this risks, and the warm-up vote keeps
 * the burst from being thirty simultaneous cache misses.
 */
const PANEL_CONCURRENCY = 8;

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

/**
 * Generation is tuned for recall, not precision. The panel supplies precision.
 *
 * The first version of this prompt did both jobs: it demanded only defects
 * "a senior engineer would stop the merge for", listed six categories to
 * suppress, and told the model that returning nothing was expected. Behind a
 * panel that independently suppresses again, that is two noise filters in
 * series, and it measured as near-silence: across five real pull requests
 * carrying 19 known findings it generated 4 candidates and reported 0.
 *
 * A generator that stays quiet cannot be rescued by anything downstream. So
 * this asks for anything plausible and pushes the judgement call to the
 * skeptics, which is the whole reason they exist. The exclusions that survive
 * are only the ones that would waste panel votes on questions another tool has
 * already answered.
 *
 * Demanding a concrete mechanism is what keeps this from becoming a noise
 * generator: a finding that names the triggering input and the resulting
 * failure can be checked, and one that does not can be dismissed cheaply.
 */
export const FIND_SYSTEM_PROMPT = [
  "You are a senior engineer reviewing a pull request diff. Your job is to surface",
  "every plausible defect in the changed code.",
  "",
  "A separate verification stage independently checks each finding you report, so",
  "you do not need to be certain. You need to be specific. Report anything you",
  "would want a second pair of eyes on.",
  "",
  "Look for: incorrect logic, data loss, race conditions, resource leaks, security",
  "holes, unhandled errors, missed edge cases, platform-specific assumptions, and",
  "violations of the repository conventions you are given.",
  "",
  "For each finding, name the concrete mechanism: the input, state, or sequence",
  "that triggers it, and what goes wrong as a result. A finding with no mechanism",
  "cannot be verified and will be discarded, so spend your words there.",
  "",
  "Skip only these, which waste verification effort:",
  "- Anything a linter, type checker, formatter, or compiler already catches.",
  "- Style preferences not stated in the repository conventions.",
  "- Issues on lines the diff does not modify.",
  "- Restating what the change is intended to do as though it were a defect.",
  "",
  "Report up to 10 findings, most severe first.",
  "",
  'Respond with JSON only: {"findings":[{"file":"path","line":123,"title":"one line",',
  '"detail":"two or three sentences naming the concrete failure mechanism"}]}',
].join("\n");

/**
 * Refutation must be grounded, not merely doubtful.
 *
 * The first version ended with "If you are uncertain, refute it." Combined with
 * majority rule that is a very high bar, because a skeptic reading a diff in
 * isolation is almost always somewhat uncertain, and two such skeptics sink a
 * finding. It showed: on a process-cleanup pull request, candidates describing
 * locale-dependent `ps` parsing and incomplete POSIX subtree kills were both
 * dropped 2-to-1, and both correspond to issues the paid reviewer flagged as
 * Major on the same lines.
 *
 * Requiring a stated reason keeps the skepticism while removing the bias.
 * "I cannot confirm this from the diff alone" stops being a rejection, which is
 * right: it is an argument about the reviewer's information, not about the
 * code. The 3-of-3 rejections under the old prompt (a claimed undefined in a
 * toast title, a variable said to be out of scope that would not have compiled)
 * are exactly the kind that still fail this version, because a concrete reason
 * they are wrong is easy to name.
 *
 * The vagueness ground closes the hole that opened up with it. Demanding a
 * specific reason to refute hands unfalsifiable claims a free pass: "other
 * callers may silently break" survived 3-0 not because anyone verified it but
 * because there is nothing specific to argue against. Generation is already
 * told to name a mechanism, so without the matching ground here the two halves
 * disagreed about what counts as a finding, and the vaguest claims sailed
 * through the gate built to stop them.
 */
export const REFUTE_SYSTEM_PROMPT = [
  "You are verifying a claimed code-review finding against the diff. Decide whether",
  "the claim is wrong.",
  "",
  "Refute it only if you can name a specific reason, one of:",
  "- The described failure cannot occur, and you can say what prevents it.",
  "- The mechanism described is inaccurate: the code actually does something else.",
  "- The issue is on lines the diff does not modify.",
  "- A linter, type checker, or compiler would already catch it.",
  "- It restates the change's intended behaviour as though it were a defect.",
  "- It names no checkable mechanism: it asserts something 'may' break or 'could'",
  "  be unsafe without saying which input, state, or sequence causes it. A claim",
  "  too vague to check is too vague to act on.",
  "",
  "Do NOT refute merely because you are unsure, because the finding seems minor, or",
  "because you cannot see the rest of the codebase. Uncertainty is not refutation.",
  "If the claim is plausible and you cannot say what is wrong with it, let it stand.",
  "",
  'Respond with JSON only: {"refuted":true|false,"reason":"the specific reason it is',
  'wrong, or why it stands"}',
].join("\n");

/**
 * Conventions, then file contents, then the diff last: the diff is the thing
 * under review, and putting it at the end keeps it in the position models
 * attend to most.
 */
export function buildFindPrompt(input: {
  readonly diff: string;
  readonly conventions: string | null;
  readonly context?: string | null;
}): string {
  const conventions = input.conventions ? `Repository conventions:\n\n${input.conventions}\n\n` : "";
  const context = input.context
    ? `Full contents of the changed files, for context (the diff below is what you are reviewing):\n\n${input.context}\n\n`
    : "";
  return `${conventions}${context}Review this diff.\n\n\`\`\`diff\n${input.diff}\n\`\`\``;
}

/**
 * The diff comes first and the claim last, which is the opposite of how it
 * reads most naturally.
 *
 * Prompt caches key on a prefix. With the claim first, every vote for every
 * finding has a different prefix from its first tokens, so nothing is ever
 * reusable and each of the `3N` votes pays full price for the same diff. With
 * the diff first, all `3N` votes on a pull request share one long prefix and
 * differ only in a short suffix, so exactly one of them is a cache miss.
 *
 * Measured on a 25k-token diff, that is most of the bill: uncached input was
 * 62% of the cost of a real run.
 */
export function buildRefutePrompt(input: {
  readonly finding: ReviewFinding;
  readonly diff: string;
}): string {
  return [
    "The diff under review:",
    "```diff",
    input.diff,
    "```",
    "",
    `Claimed finding in ${input.finding.file} at line ${input.finding.line}:`,
    input.finding.title,
    input.finding.detail,
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

interface Vote {
  readonly findingIndex: number;
  readonly verdict: RefutationVerdict;
  readonly usage: TokenUsage;
}

async function castVote(input: {
  readonly findingIndex: number;
  readonly prompt: string;
  readonly provider: ResolvedReviewProvider;
  readonly onProgress: (message: string) => void;
}): Promise<Vote> {
  try {
    const result = await requestCompletion({
      provider: input.provider,
      systemPrompt: REFUTE_SYSTEM_PROMPT,
      userPrompt: input.prompt,
      temperature: REFUTE_TEMPERATURE,
      onRetry: (message) => input.onProgress(`  retry: ${message}`),
    });
    return {
      findingIndex: input.findingIndex,
      verdict: parseVerdict(result.content),
      usage: result.usage,
    };
  } catch {
    // A panel member that errors out must not silently clear the finding.
    return {
      findingIndex: input.findingIndex,
      verdict: { refuted: true, reason: "vote failed" },
      usage: EMPTY_USAGE,
    };
  }
}

/**
 * Run every panel vote for a pull request, warming the prompt cache first.
 *
 * Votes are flattened across findings rather than run panel by panel, because
 * they all share one cacheable prefix (see {@link buildRefutePrompt}) and the
 * grouping only matters when the verdicts are counted at the end.
 *
 * The first vote runs alone. Firing the whole batch at once means none of them
 * has written the cache yet when the others start, so every one is a miss: a
 * real run showed 50.7% cached where the same prefix repeated 3N times should
 * approach 100%. Paying one extra sequential round to make the remaining votes
 * cache hits is a large net win, because uncached input dominates the bill.
 */
async function runPanel(input: {
  readonly candidates: ReadonlyArray<ReviewFinding>;
  readonly diff: string;
  readonly provider: ResolvedReviewProvider;
  readonly onProgress: (message: string) => void;
}): Promise<ReadonlyArray<AdjudicatedFinding>> {
  const prompts = input.candidates.map((finding) =>
    buildRefutePrompt({ finding, diff: input.diff }),
  );
  const tasks = input.candidates.flatMap((_, findingIndex) =>
    Array.from({ length: REFUTATION_PANEL_SIZE }, () => findingIndex),
  );
  if (tasks.length === 0) return [];

  const vote = (findingIndex: number) =>
    castVote({
      findingIndex,
      prompt: prompts[findingIndex] ?? "",
      provider: input.provider,
      onProgress: input.onProgress,
    });

  const first = await vote(tasks[0] as number);
  const rest = await mapWithConcurrency(tasks.slice(1), PANEL_CONCURRENCY, vote);
  const votes = [first, ...rest];

  return input.candidates.map((finding, findingIndex) => {
    const mine = votes.filter((entry) => entry.findingIndex === findingIndex);
    const verdicts = mine.map((entry) => entry.verdict);
    // Seeded as reported:true so `reported` stays a plain AND across the panel;
    // seeding from EMPTY_USAGE would mark every panel unreported.
    const seed: TokenUsage = { ...EMPTY_USAGE, reported: true };
    return {
      finding,
      survived: survivesPanel(verdicts),
      verdicts,
      usage: mine.reduce<TokenUsage>((total, entry) => addUsage(total, entry.usage), seed),
    };
  });
}

export interface DiffReviewResult {
  readonly candidates: ReadonlyArray<ReviewFinding>;
  readonly findings: ReadonlyArray<ReviewFinding>;
  readonly adjudicated: ReadonlyArray<AdjudicatedFinding>;
  readonly usage: TokenUsage;
  /**
   * Why generation failed, or null if it ran.
   *
   * This exists because "the model found nothing" and "the model never
   * answered" both produce an empty findings list, and reporting the second as
   * the first is the worst failure this tool has. A clean bill of health on a
   * pull request nobody reviewed is actively misleading, and it is exactly
   * what happened the first time this ran against a real diff: the request was
   * killed mid-flight and the comment read "No blocking issues found."
   *
   * Callers must check this before presenting an empty result as good news.
   */
  readonly generationError: string | null;
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
  /** Full changed-file contents; find-stage only. See src/context.ts. */
  readonly context?: string | null;
  readonly provider: ResolvedReviewProvider;
  readonly onProgress?: (message: string) => void;
}): Promise<DiffReviewResult> {
  const note = input.onProgress ?? (() => {});

  let found = { content: "", usage: EMPTY_USAGE };
  let generationError: string | null = null;
  try {
    found = await requestCompletion({
      provider: input.provider,
      systemPrompt: FIND_SYSTEM_PROMPT,
      userPrompt: buildFindPrompt({
        diff: input.diff,
        conventions: input.conventions,
        context: input.context ?? null,
      }),
      temperature: FIND_TEMPERATURE,
      onRetry: (message) => note(`  retry: ${message}`),
    });
  } catch (cause) {
    generationError = cause instanceof Error ? cause.message : String(cause);
    note(`Generation failed: ${generationError}`);
    return {
      candidates: [],
      findings: [],
      adjudicated: [],
      usage: EMPTY_USAGE,
      generationError,
    };
  }

  const candidates = parseFindings(found.content);
  note(`${candidates.length} candidate finding(s); refuting.`);

  const adjudicated = await runPanel({
    candidates,
    diff: input.diff,
    provider: input.provider,
    onProgress: note,
  });

  for (const entry of adjudicated) {
    const refuted = entry.verdicts.filter((verdict) => verdict.refuted).length;
    note(
      `  ${entry.survived ? "KEEP" : "DROP"} (${refuted}/${entry.verdicts.length} refuted) ${entry.finding.title}`,
    );
    // The stated reason is the only way to tell a panel that is discriminating
    // from one that is merely suppressing. Without it, a run of DROPs looks the
    // same whether the candidates were junk or the skeptics were too harsh.
    for (const verdict of entry.verdicts) {
      if (verdict.reason.length === 0) continue;
      note(`      ${verdict.refuted ? "refuted" : "stands"}: ${verdict.reason.slice(0, 160)}`);
    }
  }

  return {
    candidates,
    findings: adjudicated.filter((entry) => entry.survived).map((entry) => entry.finding),
    adjudicated,
    usage: adjudicated.reduce((total, entry) => addUsage(total, entry.usage), found.usage),
    generationError: null,
  };
}
