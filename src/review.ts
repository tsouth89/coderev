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

/**
 * One lens per panel seat, appended to the shared refute prompt.
 *
 * Three identical skeptics at temperature 1 apply the refutation grounds
 * stochastically: each one samples which grounds it takes seriously. It
 * showed in practice — "potentially breaking existing callers" names no
 * trigger, exactly what the vagueness ground exists to kill, yet only one
 * voter applied that ground and the claim survived 2-1. Assigning each seat
 * a lens makes every ground somebody's whole job, so coverage of the grounds
 * is guaranteed by construction instead of sampled. Majority rule is
 * unchanged, which means one lens alone can never sink a finding: a claim
 * that is specific, accurate, and in scope still stands 3-0.
 *
 * The lens rides at the end of the user prompt rather than in per-seat system
 * prompts because the panel's token cost lives in the shared diff prefix.
 * Distinct system prompts would give each seat its own cache miss over the
 * whole diff; a trailing suffix keeps one miss per finding.
 *
 * A lens is added scrutiny, never exclusive jurisdiction. The first version
 * read as jurisdiction, and a strictly literal model (Muse Spark) voted only
 * its own ground — which breaks the arithmetic: each ground has exactly one
 * seat, so a finding failing only one ground loses one vote and survives 1-2
 * by construction. Intent-restatements became mathematically unkillable, and
 * a claim this reviewer had hand-verified as false survived a unanimous
 * panel. Every seat must vote every ground; the lens only says where to dig
 * hardest.
 */
export const LENS_JURISDICTION_NOTE =
  "Your focus adds scrutiny; it does not narrow your duty. If the claim fails " +
  "ANY of the listed grounds, refute it, whether or not that ground is your focus.";

export const REFUTE_LENSES: ReadonlyArray<string> = [
  [
    "Your assigned focus for this vote: CHECKABILITY. Does the claim name the",
    "concrete input, state, or sequence that triggers the failure? If it only",
    "says something 'may', 'could', or 'potentially' happens without saying",
    "when, refute it on that ground. Be hardest on predictions: a claim that",
    "something 'will fail' or 'will break CI' is only as good as its verified",
    "mechanism — every confirmed false positive so far was a confident",
    "prediction, not a description of what the code does.",
    LENS_JURISDICTION_NOTE,
  ].join("\n"),
  [
    "Your assigned focus for this vote: MECHANISM ACCURACY. Re-read the",
    "relevant hunks and trace what the code actually does. If the code's real",
    "behaviour differs from what the claim describes, refute it on that ground.",
    "When code generates code (templates, embedded JSON.stringify, eval), trace",
    "each layer separately: a mechanism true at one layer is often false at",
    "another, and a confirmed false high survived because the claim and its",
    "check both reasoned one layer short.",
    LENS_JURISDICTION_NOTE,
  ].join("\n"),
  [
    "Your assigned focus for this vote: SCOPE AND INTENT. Is the issue on lines",
    "this diff modifies? Is it the change's intended behaviour restated as a",
    "defect? Is it a trade-off an adjacent code comment already documents and",
    "justifies? Did the code being replaced have the same flaw, making it",
    "pre-existing? Would a compiler, type checker, or linter already catch it?",
    "If any of these hold, refute it on that ground.",
    LENS_JURISDICTION_NOTE,
  ].join("\n"),
];

/** Zero for generation (reproducible), non-zero for the panel (independent). */
const FIND_TEMPERATURE = 0;
const REFUTE_TEMPERATURE = 1;

/**
 * Generator-asserted, panel-unvalidated. The panel judges whether a finding is
 * real, not how much it matters, so treat severity as the model's opinion —
 * useful for ordering and for a future gate-on-high-only mode, not as ground
 * truth. The shadow-phase audit is what validates whether its "high" means
 * anything.
 */
export type FindingSeverity = "high" | "medium" | "low";

export const SEVERITY_ORDER: Readonly<Record<FindingSeverity, number>> = {
  high: 0,
  medium: 1,
  low: 2,
};

export interface ReviewFinding {
  readonly file: string;
  readonly line: number;
  readonly title: string;
  readonly detail: string;
  readonly severity: FindingSeverity;
  /** Which generator produced it, for the audit's which-model-earns-keeps question. Absent in single-generator mode. */
  readonly source?: string;
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
  "- A trade-off that an adjacent code comment already documents and justifies.",
  "  The comment is the author answering you in advance; read it before flagging.",
  "- Defects that pre-date this diff: if the code being replaced or extended had",
  "  the same flaw, it is pre-existing even when the diff touches those lines.",
  "",
  "Rate each finding's severity:",
  '- "high": incorrect behaviour, data loss, crash, or security hole that will bite',
  "  in realistic use. A reviewer should block the merge over it.",
  '- "medium": a real defect with limited blast radius, or one needing an unusual',
  "  but reachable condition.",
  '- "low": defensive gaps, doc-versus-code mismatches, polish worth a follow-up.',
  "",
  "Report up to 10 findings, most severe first.",
  "",
  'Respond with JSON only: {"findings":[{"file":"path","line":123,"severity":"high",',
  '"title":"one line","detail":"two or three sentences naming the concrete failure',
  'mechanism"}]}',
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
  /** Tracked files near the diff; resolves file-existence claims at source. */
  readonly inventory?: string | null;
}): string {
  const conventions = input.conventions ? `Repository conventions:\n\n${input.conventions}\n\n` : "";
  const inventory = input.inventory ? `${input.inventory}\n\n` : "";
  const context = input.context
    ? `Full contents of the changed files, for context (the diff below is what you are reviewing):\n\n${input.context}\n\n`
    : "";
  return `${conventions}${inventory}${context}Review this diff.\n\n\`\`\`diff\n${input.diff}\n\`\`\``;
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
  /**
   * Full contents of the changed files, for the panel only.
   *
   * The generator does not get this by default — measured, it suppresses
   * candidate volume — but the panel only verifies, and its confirmed
   * high-severity false positive ("state.license is never refreshed") was
   * refutable by a line sitting in a changed file the panel could not see.
   * Universal negatives about nearby code are checkable exactly here.
   */
  readonly context?: string | null;
  /**
   * Sits between the diff and the claim: identical for every vote on a pull
   * request, so it extends the shared cacheable prefix rather than breaking
   * it, and it puts file-existence facts inside the panel's evidence — the
   * one confirmed post-lens-fix false positive survived precisely because
   * that fact lived outside the diff.
   */
  readonly inventory?: string | null;
}): string {
  return [
    "The diff under review:",
    "```diff",
    input.diff,
    "```",
    ...(input.context
      ? ["", "Full contents of the changed files, for verifying claims about them:", "", input.context]
      : []),
    ...(input.inventory ? ["", input.inventory] : []),
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

    const severity = record.severity;
    findings.push({
      file,
      line: typeof record.line === "number" && Number.isFinite(record.line) ? record.line : 0,
      title,
      detail: typeof record.detail === "string" ? record.detail.trim() : "",
      // Missing or invalid rates as medium: assuming high would let a silent
      // omission block merges under a future gate, assuming low would bury it.
      severity: severity === "high" || severity === "medium" || severity === "low" ? severity : "medium",
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

/**
 * Files whose diffs are machine-written: reviewing them bills large token
 * counts for near-certain noise. Production produced a severity:high finding
 * on line 1000 of a pnpm-lock.yaml — a file no human edits — and lockfile
 * hunks routinely run to thousands of lines that then ride every panel vote.
 */
const GENERATED_FILE_PATTERN =
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum|composer\.lock|Gemfile\.lock)$|\.(min\.js|min\.css|map|lock)$/;

/**
 * Drop generated-file hunks from a diff, disclosing what was dropped so the
 * model knows dependency changes happened without reading their lockfiles.
 */
export function stripGeneratedHunks(diff: string): {
  readonly diff: string;
  readonly stripped: ReadonlyArray<string>;
} {
  const sections = diff.split(/^(?=diff --git )/m);
  const kept: Array<string> = [];
  const stripped: Array<string> = [];
  for (const section of sections) {
    const match = section.match(/^diff --git a\/.+? b\/(.+)$/m);
    const path = match?.[1];
    if (path !== undefined && GENERATED_FILE_PATTERN.test(path)) {
      stripped.push(path);
      continue;
    }
    kept.push(section);
  }
  if (stripped.length === 0) return { diff, stripped };
  const notice = `(Generated files changed but omitted from this diff: ${stripped.join(", ")})
`;
  return { diff: notice + kept.join(""), stripped };
}

export function truncateDiff(
  diff: string,
  limit: number = MAX_DIFF_CHARACTERS,
): { readonly diff: string; readonly truncated: boolean } {
  if (diff.length <= limit) return { diff, truncated: false };
  return { diff: diff.slice(0, limit), truncated: true };
}

export const REVIEW_COMMENT_MARKER = "<!-- coderev -->";

/**
 * Machine-readable state embedded in the posted comment, base64 so no JSON
 * character sequence can terminate the HTML comment.
 *
 * The upserted comment persists across pushes, which makes it the natural
 * memory between passes. Without it every re-review presented its findings as
 * if seen for the first time: a measured pass on a 25-line follow-up fix
 * reported nine findings of which the author judged two actionable, largely
 * re-flagging the neighbourhood the previous pass had already covered.
 */
const STATE_PATTERN = /<!-- coderev:state:v1 ([A-Za-z0-9+/=]+) -->/;

export interface PreviousFinding {
  readonly file: string;
  readonly line: number;
  readonly title: string;
  readonly severity: FindingSeverity;
}

export function embedState(findings: ReadonlyArray<PreviousFinding>): string {
  const payload = findings.map(({ file, line, title, severity }) => ({
    file,
    line,
    title,
    severity,
  }));
  const encoded = Buffer.from(JSON.stringify({ findings: payload }), "utf8").toString("base64");
  return `<!-- coderev:state:v1 ${encoded} -->`;
}

/** Previous pass's findings out of an existing comment body, or null. */
export function parsePreviousState(body: string): ReadonlyArray<PreviousFinding> | null {
  const match = body.match(STATE_PATTERN);
  if (!match?.[1]) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const list = (parsed as Record<string, unknown>).findings;
    if (!Array.isArray(list)) return null;
    const findings: Array<PreviousFinding> = [];
    for (const entry of list) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.file !== "string" || typeof record.title !== "string") continue;
      const severity = record.severity;
      findings.push({
        file: record.file,
        line: typeof record.line === "number" ? record.line : 0,
        title: record.title,
        severity:
          severity === "high" || severity === "medium" || severity === "low"
            ? severity
            : "medium",
      });
    }
    return findings;
  } catch {
    return null;
  }
}

/** Same-concern test across passes: same file, similar title — the pre-panel dedupe rule. */
export function matchesPrevious(
  finding: { readonly file: string; readonly title: string },
  previous: ReadonlyArray<PreviousFinding>,
): boolean {
  const tokens = titleTokens(finding.title);
  return previous.some(
    (entry) =>
      entry.file === finding.file &&
      jaccard(titleTokens(entry.title), tokens) >= DEDUPE_SIMILARITY_THRESHOLD,
  );
}

/**
 * Words that carry no identity: with them included, two phrasings of the same
 * defect ("teardown hangs due to .cmd shim" / "teardown test hangs on
 * Windows") score as different findings.
 */
const TITLE_STOPWORDS = new Set([
  "a", "an", "the", "to", "on", "in", "of", "for", "due", "when", "may",
  "can", "could", "is", "are", "and", "or", "with", "via", "because",
]);

function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 0 && !TITLE_STOPWORDS.has(token)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/** Titles sharing at least half their meaningful words are the same concern. */
export const DEDUPE_SIMILARITY_THRESHOLD = 0.5;

/**
 * Union two generators' candidates, dropping the second generator's near
 * duplicates before the panel sees them.
 *
 * Presentation dedupe (dedupeFindings) merges across files on purpose; this
 * one is deliberately narrower — same file plus similar title — because its
 * job is only to stop paying three panel votes twice for one finding phrased
 * two ways. A missed dedupe costs votes and is then merged at presentation; an
 * overeager one silently discards a distinct finding, which is worse.
 */
export function unionCandidates(
  primary: ReadonlyArray<ReviewFinding>,
  secondary: ReadonlyArray<ReviewFinding>,
): Array<ReviewFinding> {
  const union = [...primary];
  for (const candidate of secondary) {
    const candidateTokens = titleTokens(candidate.title);
    const duplicate = union.some(
      (existing) =>
        existing.file === candidate.file &&
        jaccard(titleTokens(existing.title), candidateTokens) >= DEDUPE_SIMILARITY_THRESHOLD,
    );
    if (!duplicate) union.push(candidate);
  }
  return union;
}

export interface GroupedFinding {
  readonly title: string;
  readonly detail: string;
  readonly severity: FindingSeverity;
  readonly locations: ReadonlyArray<{ readonly file: string; readonly line: number }>;
}

/**
 * Merge findings that describe the same defect in different places.
 *
 * A defect in a shared helper surfaces once per call site: one benchmark run
 * reported the same test-harness claim as three separate findings across three
 * test files. Three near-identical bullets read as noise even when the finding
 * is right, and noise is the one thing this tool exists to not produce. The
 * first finding in a group keeps its title and detail (generation orders by
 * severity, so the first phrasing is the one the model led with), and the
 * merged locations are listed together.
 *
 * Grouping is greedy against each group's head rather than transitive-closure,
 * so two findings that each half-match a middle one do not chain into a single
 * mega-group.
 */
export function dedupeFindings(findings: ReadonlyArray<ReviewFinding>): Array<GroupedFinding> {
  const groups: Array<{ head: Set<string>; grouped: GroupedFinding }> = [];
  for (const finding of findings) {
    const tokens = titleTokens(finding.title);
    const existing = groups.find(
      (group) => jaccard(group.head, tokens) >= DEDUPE_SIMILARITY_THRESHOLD,
    );
    if (existing) {
      existing.grouped = {
        ...existing.grouped,
        locations: [...existing.grouped.locations, { file: finding.file, line: finding.line }],
      };
      continue;
    }
    groups.push({
      head: tokens,
      grouped: {
        title: finding.title,
        detail: finding.detail,
        severity: finding.severity,
        locations: [{ file: finding.file, line: finding.line }],
      },
    });
  }
  return groups.map((group) => group.grouped);
}

export function formatReviewComment(input: {
  readonly findings: ReadonlyArray<ReviewFinding>;
  readonly model: string;
  readonly truncated: boolean;
  /** Previous pass's findings; enables new / still-open / resolved sectioning. */
  readonly previous?: ReadonlyArray<PreviousFinding> | null;
}): string {
  const lines = [REVIEW_COMMENT_MARKER, "", "### Automated review", ""];

  // Stable sort by severity so the gate-relevant findings lead; within a tier
  // the generator's own most-severe-first ordering is preserved.
  const grouped = dedupeFindings(input.findings)
    .map((finding, index) => ({ finding, index }))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.finding.severity] - SEVERITY_ORDER[b.finding.severity] ||
        a.index - b.index,
    )
    .map((entry) => entry.finding);
  const previous = input.previous ?? null;
  const isCarried = (finding: GroupedFinding): boolean =>
    previous !== null &&
    finding.locations.some((location) =>
      matchesPrevious({ file: location.file, title: finding.title }, previous),
    );
  const fresh = previous === null ? grouped : grouped.filter((finding) => !isCarried(finding));
  const carried = previous === null ? [] : grouped.filter(isCarried);
  const resolved =
    previous === null
      ? []
      : previous.filter(
          (entry) =>
            !grouped.some((finding) =>
              finding.locations.some((location) =>
                matchesPrevious({ file: location.file, title: finding.title }, [entry]),
              ),
            ),
        );

  const renderFull = (finding: GroupedFinding, index: number) => {
    lines.push(`${index + 1}. **${finding.title}**`, "");
    const rendered = finding.locations
      .map((location) => `\`${location.file}\`${location.line > 0 ? `:${location.line}` : ""}`)
      .join(", ");
    lines.push(`   ${rendered} \u00b7 severity: ${finding.severity}`, "");
    if (finding.detail.length > 0) lines.push(`   ${finding.detail}`, "");
  };

  if (grouped.length === 0) {
    lines.push("No blocking issues found.");
    if (resolved.length > 0) {
      lines.push("", `Resolved since the previous pass: ${resolved.length}.`);
    }
  } else if (previous === null) {
    const noun = grouped.length === 1 ? "issue" : "issues";
    lines.push(`Found ${grouped.length} ${noun}:`, "");
    grouped.forEach(renderFull);
  } else {
    // Re-review of a PR this tool has already commented on. Findings the
    // previous pass reported stay visible — hiding an unresolved high would be
    // the false all-clear again, quieter — but compactly, so the reader's
    // attention lands on what changed.
    if (fresh.length > 0) {
      const noun = fresh.length === 1 ? "issue" : "issues";
      lines.push(`New in this pass: ${fresh.length} ${noun}.`, "");
      fresh.forEach(renderFull);
    } else {
      lines.push("Nothing new in this pass.");
    }
    if (carried.length > 0) {
      lines.push("", `Still open from the previous pass:`, "");
      for (const finding of carried) {
        const where = finding.locations
          .map((location) => `\`${location.file}\`${location.line > 0 ? `:${location.line}` : ""}`)
          .join(", ");
        lines.push(`- **${finding.title}** \u2014 ${where} \u00b7 ${finding.severity}`);
      }
    }
    if (resolved.length > 0) {
      lines.push("", `Resolved since the previous pass: ${resolved.length}.`);
    }
  }

  if (input.truncated) {
    lines.push("", "_The diff exceeded the review size limit and was truncated._");
  }
  lines.push(
    "",
    `<sub>Advisory. Generated by \`${input.model}\` and filtered through a ${REFUTATION_PANEL_SIZE}-vote refutation panel.</sub>`,
    "",
    embedState(
      grouped.flatMap((finding) =>
        finding.locations.map((location) => ({
          file: location.file,
          line: location.line,
          title: finding.title,
          severity: finding.severity,
        })),
      ),
    ),
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
  readonly lens: string;
  readonly provider: ResolvedReviewProvider;
  readonly onProgress: (message: string) => void;
}): Promise<Vote> {
  try {
    const result = await requestCompletion({
      provider: input.provider,
      systemPrompt: REFUTE_SYSTEM_PROMPT,
      userPrompt: `${input.prompt}

${input.lens}`,
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
  readonly inventory?: string | null;
  readonly context?: string | null;
  /** The panel's provider — may differ from the generator's. */
  readonly provider: ResolvedReviewProvider;
  readonly onProgress: (message: string) => void;
}): Promise<ReadonlyArray<AdjudicatedFinding>> {
  const prompts = input.candidates.map((finding) =>
    buildRefutePrompt({
      finding,
      diff: input.diff,
      inventory: input.inventory ?? null,
      context: input.context ?? null,
    }),
  );
  const tasks = input.candidates.flatMap((_, findingIndex) =>
    Array.from({ length: REFUTATION_PANEL_SIZE }, (_, seat) => ({ findingIndex, seat })),
  );
  if (tasks.length === 0) return [];

  const vote = (task: { readonly findingIndex: number; readonly seat: number }) =>
    castVote({
      findingIndex: task.findingIndex,
      prompt: prompts[task.findingIndex] ?? "",
      lens: REFUTE_LENSES[task.seat % REFUTE_LENSES.length] ?? "",
      provider: input.provider,
      onProgress: input.onProgress,
    });

  const first = await vote(tasks[0] as { findingIndex: number; seat: number });
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
   * Usage split by stage. With hybrid routing the two stages bill at different
   * models' rates, so a single total priced at one model's rate would be
   * quietly wrong in whichever direction the rates differ.
   */
  readonly findUsage: TokenUsage;
  /** Second generator's usage; EMPTY_USAGE in single-generator mode. */
  readonly find2Usage: TokenUsage;
  readonly panelUsage: TokenUsage;
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
  /** Full changed-file contents for the GENERATOR; measured to suppress candidate volume, so callers gate it behind --context. */
  readonly context?: string | null;
  /** Full changed-file contents for the PANEL; verification-only evidence, on by default in callers. */
  readonly panelContext?: string | null;
  /** Tracked-file inventory for the touched directories; see src/inventory.ts. */
  readonly inventory?: string | null;
  readonly provider: ResolvedReviewProvider;
  /** Second generator for dual-generator mode; its candidates union with the primary's. */
  readonly find2Provider?: ResolvedReviewProvider;
  /**
   * Provider for the refutation panel; defaults to `provider`. Split because
   * the stages have opposite economics and failure modes: the strongest
   * generator measured had the most lenient panel, and the panel's 3N re-sent
   * diffs are nearly free only under aggressive cache pricing.
   */
  readonly refuteProvider?: ResolvedReviewProvider;
  readonly onProgress?: (message: string) => void;
}): Promise<DiffReviewResult> {
  const note = input.onProgress ?? (() => {});

  const findPrompt = buildFindPrompt({
    diff: input.diff,
    conventions: input.conventions,
    context: input.context ?? null,
    inventory: input.inventory ?? null,
  });
  const generate = async (provider: ResolvedReviewProvider) =>
    requestCompletion({
      provider,
      systemPrompt: FIND_SYSTEM_PROMPT,
      userPrompt: findPrompt,
      temperature: FIND_TEMPERATURE,
      onRetry: (message) => note(`  retry: ${message}`),
    });

  // Both generators run concurrently. One failing degrades to single-generator
  // coverage with a warning; the review only counts as not-run when EVERY
  // generator failed, because a partial hunt is still a hunt while a silent
  // all-clear from a review that never happened is the worst output this tool
  // can produce.
  const [primary, secondary] = await Promise.all([
    generate(input.provider).then(
      (result) => ({ ok: true as const, result }),
      (cause: unknown) => ({
        ok: false as const,
        error: cause instanceof Error ? cause.message : String(cause),
      }),
    ),
    input.find2Provider
      ? generate(input.find2Provider).then(
          (result) => ({ ok: true as const, result }),
          (cause: unknown) => ({
            ok: false as const,
            error: cause instanceof Error ? cause.message : String(cause),
          }),
        )
      : Promise.resolve(null),
  ]);

  if (!primary.ok && (secondary === null || !secondary.ok)) {
    const generationError = [
      `${input.provider.model}: ${primary.error}`,
      ...(secondary !== null && !secondary.ok
        ? [`${input.find2Provider?.model ?? "find2"}: ${secondary.error}`]
        : []),
    ].join("; ");
    note(`Generation failed: ${generationError}`);
    return {
      candidates: [],
      findings: [],
      adjudicated: [],
      usage: EMPTY_USAGE,
      findUsage: EMPTY_USAGE,
      find2Usage: EMPTY_USAGE,
      panelUsage: EMPTY_USAGE,
      generationError,
    };
  }
  if (!primary.ok) note(`Primary generator failed, continuing on the second: ${primary.error}`);
  if (secondary !== null && !secondary.ok) {
    note(`Second generator failed, continuing single-generator: ${secondary.error}`);
  }

  const tag = (findings: ReadonlyArray<ReviewFinding>, source: string) =>
    findings.map((finding) => ({ ...finding, source }));
  const primaryCandidates = primary.ok
    ? tag(parseFindings(primary.result.content), input.provider.model)
    : [];
  const secondaryCandidates =
    secondary !== null && secondary.ok && input.find2Provider
      ? tag(parseFindings(secondary.result.content), input.find2Provider.model)
      : [];
  const candidates = unionCandidates(primaryCandidates, secondaryCandidates);
  // A stage that made no request has a known usage of zero, not an unknown
  // one: EMPTY_USAGE's reported:false would AND-poison every total it is
  // summed into and turn a fully-measured single-generator review into
  // "cost unknown".
  const knownZero: TokenUsage = { ...EMPTY_USAGE, reported: true };
  const found = { usage: primary.ok ? primary.result.usage : knownZero };
  const find2Usage = secondary !== null && secondary.ok ? secondary.result.usage : knownZero;
  note(
    secondaryCandidates.length > 0 || input.find2Provider
      ? `${candidates.length} candidate finding(s) (${primaryCandidates.length} + ${secondaryCandidates.length}, deduped); refuting.`
      : `${candidates.length} candidate finding(s); refuting.`,
  );

  const adjudicated = await runPanel({
    candidates,
    diff: input.diff,
    inventory: input.inventory ?? null,
    context: input.panelContext ?? null,
    provider: input.refuteProvider ?? input.provider,
    onProgress: note,
  });

  for (const entry of adjudicated) {
    const refuted = entry.verdicts.filter((verdict) => verdict.refuted).length;
    note(
      `  ${entry.survived ? "KEEP" : "DROP"} (${refuted}/${entry.verdicts.length} refuted) ` +
        `${entry.finding.file}:${entry.finding.line} ${entry.finding.title}` +
        (entry.finding.source ? ` [${entry.finding.source}]` : ""),
    );
    // The stated reason is the only way to tell a panel that is discriminating
    // from one that is merely suppressing. Without it, a run of DROPs looks the
    // same whether the candidates were junk or the skeptics were too harsh.
    for (const verdict of entry.verdicts) {
      if (verdict.reason.length === 0) continue;
      note(`      ${verdict.refuted ? "refuted" : "stands"}: ${verdict.reason.slice(0, 160)}`);
    }
  }

  const panelSeed: TokenUsage = { ...EMPTY_USAGE, reported: true };
  const panelUsage = adjudicated.reduce<TokenUsage>(
    (total, entry) => addUsage(total, entry.usage),
    panelSeed,
  );
  return {
    candidates,
    findings: adjudicated.filter((entry) => entry.survived).map((entry) => entry.finding),
    adjudicated,
    usage: addUsage(addUsage(found.usage, find2Usage), panelUsage),
    findUsage: found.usage,
    find2Usage,
    panelUsage,
    generationError: null,
  };
}
