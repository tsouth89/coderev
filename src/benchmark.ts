/**
 * Measures what a candidate review model costs and what it agrees with.
 *
 * Runs the exact pipeline the reviewer ships (find, then refute by panel)
 * across a recorded set of pull requests, for one or more models, and reports
 * measured cost against agreement with a baseline reviewer.
 *
 * What this can and cannot tell you:
 *
 * It CAN tell you the real dollar cost of reviewing a real PR with a given
 * model, measured from reported token usage rather than estimated from diff
 * size. That number decides whether a find-then-refute pipeline is affordable,
 * and it is the number nobody can look up.
 *
 * It CANNOT tell you which reviewer is right. Agreement with a baseline is
 * agreement with whatever that baseline happened to say, including findings its
 * own authors ignored. Read `unmatched` as "needs a human read", never as
 * "false positive" — the counts are a triage aid, not a verdict.
 *
 * Diffs are fetched once per PR and reused across models, so adding a model
 * costs model tokens rather than another pass over GitHub.
 */
import { fetchPullRequestDiff } from "./github.ts";
import {
  addUsage,
  EMPTY_USAGE,
  estimateCostUsd,
  type ResolvedReviewProvider,
  type TokenUsage,
} from "./provider.ts";
import { reviewDiff, truncateDiff } from "./review.ts";

export interface BaselineFinding {
  readonly file: string;
  readonly line: number;
}

export interface BenchmarkCase {
  readonly pr: number;
  /**
   * Whether the pull request received any commit after the baseline review
   * landed. A baseline finding nobody acted on is weak evidence of quality, so
   * matching one should not be scored the same as matching a finding that
   * caused a fix.
   */
  readonly actedOn: boolean;
  readonly baseline: ReadonlyArray<BaselineFinding>;
}

export interface BenchmarkSuite {
  readonly repo: string;
  readonly baselineReviewer: string;
  readonly capturedAt: string;
  readonly notes?: string;
  readonly cases: ReadonlyArray<BenchmarkCase>;
}

/**
 * How far apart two line numbers can be and still count as the same concern.
 *
 * Reviewers anchor comments at different points within one problem — the
 * declaration, the branch, the return — so exact line equality would score
 * agreement as disagreement. Twenty lines is wide enough to survive that and
 * narrow enough that two unrelated issues in one file do not collide.
 */
export const LINE_MATCH_TOLERANCE = 20;

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function matchesBaseline(
  finding: { readonly file: string; readonly line: number },
  baseline: ReadonlyArray<BaselineFinding>,
): boolean {
  const file = normalizePath(finding.file);
  return baseline.some(
    (entry) =>
      normalizePath(entry.file) === file &&
      Math.abs(entry.line - finding.line) <= LINE_MATCH_TOLERANCE,
  );
}

/** Validate a suite loaded from JSON rather than trusting the file's shape. */
export function parseBenchmarkSuite(raw: unknown): BenchmarkSuite {
  if (typeof raw !== "object" || raw === null) throw new Error("suite must be an object");
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.cases)) throw new Error("suite.cases must be an array");

  const cases = record.cases.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) throw new Error(`case ${index} is not object`);
    const c = entry as Record<string, unknown>;
    if (typeof c.pr !== "number") throw new Error(`case ${index} needs a numeric pr`);
    if (!Array.isArray(c.baseline)) throw new Error(`case ${index} needs a baseline array`);
    return {
      pr: c.pr,
      actedOn: c.actedOn === true,
      baseline: c.baseline.map((finding, findingIndex) => {
        if (typeof finding !== "object" || finding === null) {
          throw new Error(`case ${index} baseline ${findingIndex} is not an object`);
        }
        const f = finding as Record<string, unknown>;
        if (typeof f.file !== "string") throw new Error(`case ${index} baseline needs a file`);
        return { file: f.file, line: typeof f.line === "number" ? f.line : 0 };
      }),
    } satisfies BenchmarkCase;
  });

  return {
    repo: typeof record.repo === "string" ? record.repo : "unknown",
    baselineReviewer:
      typeof record.baselineReviewer === "string" ? record.baselineReviewer : "baseline",
    capturedAt: typeof record.capturedAt === "string" ? record.capturedAt : "unknown",
    ...(typeof record.notes === "string" ? { notes: record.notes } : {}),
    cases,
  };
}

export interface CaseScore {
  readonly pr: number;
  readonly actedOn: boolean;
  readonly baselineCount: number;
  readonly reported: number;
  readonly matched: number;
  readonly unmatched: number;
  readonly candidates: number;
  readonly usage: TokenUsage;
  /**
   * Set when the review never ran. Such a case contributes no findings, so
   * leaving it in the totals would quietly depress the model's apparent
   * agreement and make an infrastructure failure look like a quality result.
   */
  readonly failed: boolean;
}

export interface ModelScore {
  readonly model: string;
  readonly cases: ReadonlyArray<CaseScore>;
  readonly usage: TokenUsage;
  readonly costUsd: number | null;
}

/**
 * Score one case.
 *
 * `matched` counts reported findings that land on a baseline finding, not
 * baseline findings that were covered. The two differ when a model reports two
 * findings against one baseline entry, and the reported-side count is the one
 * that reflects what a human would actually read.
 */
export function scoreCase(input: {
  readonly benchmarkCase: BenchmarkCase;
  readonly findings: ReadonlyArray<{ readonly file: string; readonly line: number }>;
  readonly candidates: number;
  readonly usage: TokenUsage;
  readonly failed?: boolean;
}): CaseScore {
  const matched = input.findings.filter((finding) =>
    matchesBaseline(finding, input.benchmarkCase.baseline),
  ).length;
  return {
    pr: input.benchmarkCase.pr,
    actedOn: input.benchmarkCase.actedOn,
    baselineCount: input.benchmarkCase.baseline.length,
    reported: input.findings.length,
    matched,
    unmatched: input.findings.length - matched,
    candidates: input.candidates,
    usage: input.usage,
    failed: input.failed === true,
  };
}

export function formatBenchmarkReport(
  suite: BenchmarkSuite,
  scores: ReadonlyArray<ModelScore>,
): string {
  const lines: Array<string> = [
    "",
    "## Review benchmark",
    "",
    `Repo: ${suite.repo} · baseline: ${suite.baselineReviewer} · captured ${suite.capturedAt}`,
    "",
  ];

  for (const score of scores) {
    const sum = (pick: (entry: CaseScore) => number) => score.cases.reduce((a, e) => a + pick(e), 0);
    const reported = sum((e) => e.reported);
    const matched = sum((e) => e.matched);
    const failed = score.cases.filter((entry) => entry.failed).length;
    const scored = score.cases.length - failed;
    const actedOnMatched = score.cases
      .filter((entry) => entry.actedOn)
      .reduce((a, e) => a + e.matched, 0);
    const perPr =
      score.costUsd === null || scored === 0
        ? "unknown"
        : `$${(score.costUsd / scored).toFixed(4)}`;

    lines.push(
      `### ${score.model}`,
      "",
      ...(failed > 0
        ? [
            `> **${failed} of ${score.cases.length} reviews failed to run.** Those are excluded`,
            `> from the rates below; the numbers describe the ${scored} that completed.`,
            "",
          ]
        : []),
      `- Cost: ${score.costUsd === null ? "unknown (provider reported no usage)" : `$${score.costUsd.toFixed(4)}`} across ${scored} completed PR(s), ${perPr} per PR`,
      `- Tokens: ${score.usage.inputTokens} in (${score.usage.cachedInputTokens} cached), ${score.usage.outputTokens} out`,
      `- Findings: ${sum((e) => e.candidates)} generated, ${reported} survived the panel`,
      `- Agreement: ${matched}/${reported} reported findings match the baseline (${sum((e) => e.baselineCount)} baseline findings total)`,
      `- Of those matches, ${actedOnMatched} are on PRs the author actually acted on`,
      `- Unmatched: ${reported - matched} findings need a human read`,
      "",
      "| PR | acted on | baseline | generated | kept | matched |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const entry of score.cases) {
      lines.push(
        entry.failed
          ? `| ${entry.pr} | ${entry.actedOn ? "yes" : "no"} | ${entry.baselineCount} | _failed_ | _failed_ | _failed_ |`
          : `| ${entry.pr} | ${entry.actedOn ? "yes" : "no"} | ${entry.baselineCount} | ${entry.candidates} | ${entry.reported} | ${entry.matched} |`,
      );
    }
    lines.push("");
  }

  lines.push(
    `_Agreement with ${suite.baselineReviewer} is not correctness. Unmatched findings may be real defects the baseline missed._`,
    "",
  );
  return lines.join("\n");
}

export async function runBenchmark(input: {
  readonly suite: BenchmarkSuite;
  readonly baseProvider: ResolvedReviewProvider;
  readonly models: ReadonlyArray<string>;
  readonly limit: number;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly onProgress?: (message: string) => void;
}): Promise<Array<ModelScore>> {
  const note = input.onProgress ?? (() => {});
  const cases = input.suite.cases.slice(0, input.limit);
  const models = input.models.length > 0 ? input.models : [input.baseProvider.model];

  note(`Fetching ${cases.length} diff(s)...`);
  const diffs = new Map<number, string>();
  for (const benchmarkCase of cases) {
    const raw = await fetchPullRequestDiff(String(benchmarkCase.pr), input.cwd);
    diffs.set(benchmarkCase.pr, truncateDiff(raw).diff);
  }

  const scores: Array<ModelScore> = [];
  for (const model of models) {
    note(`\n=== ${model} ===`);
    const provider = { ...input.baseProvider, model };
    const caseScores: Array<CaseScore> = [];

    for (const benchmarkCase of cases) {
      note(`PR ${benchmarkCase.pr}...`);
      const result = await reviewDiff({
        diff: diffs.get(benchmarkCase.pr) ?? "",
        conventions: null,
        provider,
      });
      if (result.generationError !== null) {
        note(`  FAILED: ${result.generationError}`);
      }
      caseScores.push(
        scoreCase({
          benchmarkCase,
          findings: result.findings,
          candidates: result.candidates.length,
          usage: result.usage,
          failed: result.generationError !== null,
        }),
      );
    }

    const usage = caseScores.reduce((total, entry) => addUsage(total, entry.usage), {
      ...EMPTY_USAGE,
      reported: true,
    });
    scores.push({
      model,
      cases: caseScores,
      usage,
      costUsd: estimateCostUsd(model, usage, input.env ?? {}),
    });
  }

  return scores;
}
