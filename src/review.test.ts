import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildRefutePrompt,
  dedupeFindings,
  extractJsonObject,
  FIND_SYSTEM_PROMPT,
  formatReviewComment,
  countChangedLines,
  DEFAULT_MAX_ROUNDS,
  LARGE_DIFF_MAX_ROUNDS,
  LENS_JURISDICTION_NOTE,
  maxRoundsForDiff,
  parseBatchVerdicts,
  parseDroppedFindings,
  parseRound,
  parseFindings,
  parsePreviousState,
  parseStoredDiffHash,
  parseVerdict,
  REFUTATION_PANEL_SIZE,
  REFUTE_LENSES,
  REVIEW_COMMENT_MARKER,
  survivesPanel,
  truncateDiff,
  unionCandidates,
} from "./review.ts";

describe("FIND_SYSTEM_PROMPT output contract", () => {
  it("pins confidence and disposition in both instructions and JSON shape", () => {
    assert.match(FIND_SYSTEM_PROMPT, /Include confidence: "high", "medium", or "low"/);
    assert.match(FIND_SYSTEM_PROMPT, /Include disposition: "block"/);
    assert.match(FIND_SYSTEM_PROMPT, /"confidence":"high","disposition":"block"/);
  });
});

describe("extractJsonObject", () => {
  it("parses a bare object", () => {
    assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
  });

  it("parses through a fenced block", () => {
    // Models emit fences even when told to return JSON only; throwing away the
    // run over a fence would waste the whole request.
    assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 });
  });

  it("parses an object wrapped in prose", () => {
    assert.deepEqual(extractJsonObject('Here you go:\n{"a":1}\nHope that helps.'), { a: 1 });
  });

  it("returns null when there is no object", () => {
    assert.equal(extractJsonObject("no json here"), null);
  });
});

describe("parseFindings", () => {
  it("keeps well-formed findings", () => {
    assert.deepEqual(
      parseFindings(
        '{"findings":[{"file":"a.ts","line":12,"title":"Leak","detail":"Handle never closed."}]}',
      ),
      [{ file: "a.ts", line: 12, title: "Leak", detail: "Handle never closed.", severity: "medium" }],
    );
  });

  it("drops entries missing a file or title rather than inventing one", () => {
    const findings = parseFindings(
      '{"findings":[{"file":"","title":"x"},{"file":"a.ts","title":""},{"file":"a.ts","title":"ok"}]}',
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.title, "ok");
  });

  it("defaults a missing line to zero instead of NaN", () => {
    // NaN would render as "a.ts:NaN" in the posted comment.
    assert.equal(parseFindings('{"findings":[{"file":"a.ts","title":"x"}]}')[0]?.line, 0);
  });

  it("reads a valid severity and defaults anything else to medium", () => {
    const findings = parseFindings(
      '{"findings":[{"file":"a.ts","title":"x","severity":"high"},{"file":"b.ts","title":"y","severity":"catastrophic"},{"file":"c.ts","title":"z"}]}',
    );
    // Defaulting to high would let a silent omission block merges under a
    // future gate; defaulting to low would bury real findings. Medium is the
    // only neutral reading of "the model did not say".
    assert.deepEqual(
      findings.map((finding) => finding.severity),
      ["high", "medium", "medium"],
    );
  });

  it("reads the fix direction and effort tag when present", () => {
    const findings = parseFindings(
      '{"findings":[{"file":"a.ts","line":5,"title":"Race","severity":"high","effort":"quick","fix":"Serialize per-session updates; add a reverse-completion-order test."},{"file":"b.ts","title":"x","effort":"heroic"}]}',
    );
    assert.equal(findings[0]?.fix, "Serialize per-session updates; add a reverse-completion-order test.");
    assert.equal(findings[0]?.effort, "quick");
    // Invalid effort is omitted, not guessed.
    assert.equal(findings[1]?.effort, undefined);
  });

  it("reads valid confidence and disposition without guessing invalid values", () => {
    const findings = parseFindings(
      '{"findings":[{"file":"a.ts","title":"x","confidence":"high","disposition":"follow-up"},{"file":"b.ts","title":"y","confidence":"certain","disposition":"urgent"}]}',
    );
    assert.equal(findings[0]?.confidence, "high");
    assert.equal(findings[0]?.disposition, "follow-up");
    assert.equal(findings[1]?.confidence, undefined);
    assert.equal(findings[1]?.disposition, undefined);
  });

  it("returns empty for a non-list findings field", () => {
    assert.deepEqual(parseFindings('{"findings":"none"}'), []);
  });

  it("returns empty for unparseable output", () => {
    assert.deepEqual(parseFindings("the model apologised instead"), []);
  });
});

describe("parseVerdict", () => {
  it("reads an explicit verdict", () => {
    assert.deepEqual(parseVerdict('{"refuted":false,"reason":"confirmed in diff"}'), {
      refuted: false,
      reason: "confirmed in diff",
    });
  });

  it("treats unparseable output as a refusal to clear the finding", () => {
    // Counting an unreadable vote as "not refuted" would promote a finding that
    // no panel member actually vouched for.
    assert.equal(parseVerdict("shrug").refuted, true);
  });

  it("treats a missing refuted field as refuted", () => {
    assert.equal(parseVerdict('{"reason":"maybe"}').refuted, true);
  });
});

describe("REFUTE_LENSES", () => {
  it("every seat carries the jurisdiction note", () => {
    // This invariant was silently lost once: a patch rewrote only the doc
    // comment while the commit message claimed the behavioural fix, and the
    // panel ran seat-exclusive lenses through three config versions. A lens
    // without this note breaks the arithmetic — a finding failing only one
    // ground loses exactly one vote and survives 1-2 by construction.
    assert.equal(REFUTE_LENSES.length, REFUTATION_PANEL_SIZE);
    for (const lens of REFUTE_LENSES) {
      assert.ok(
        lens.includes(LENS_JURISDICTION_NOTE),
        `lens missing jurisdiction note: ${lens.slice(0, 60)}`,
      );
    }
  });
});

describe("REFUTE_LENSES seat order", () => {
  it("keeps mechanism and scope in the always-voting pair", () => {
    // Load-bearing under pair-then-tiebreak: seats 0 and 1 always vote, seat 2
    // only on splits. When checkability held a pair seat and scope was the
    // tiebreak, the scope grounds (pre-existing, comment-answered, intent,
    // repo-characteristic) went mostly uncast and fleet keep rates jumped
    // from 42% to 60-90% in a day.
    assert.match(REFUTE_LENSES[0] ?? "", /MECHANISM ACCURACY/);
    assert.match(REFUTE_LENSES[1] ?? "", /SCOPE AND INTENT/);
    assert.match(REFUTE_LENSES[2] ?? "", /CHECKABILITY/);
  });
});

describe("parseBatchVerdicts", () => {
  it("maps verdicts onto their claim numbers", () => {
    const parsed = parseBatchVerdicts(
      '{"verdicts":[{"claim":2,"refuted":false,"reason":"traced and confirmed"},{"claim":1,"refuted":true,"reason":"pre-existing"}]}',
      2,
    );
    assert.deepEqual(parsed[0], { refuted: true, reason: "pre-existing" });
    assert.deepEqual(parsed[1], { refuted: false, reason: "traced and confirmed" });
  });

  it("counts a claim the panel skipped as refuted", () => {
    // Silence must never promote a finding nobody vouched for — the same rule
    // the single-verdict parser has always enforced.
    const parsed = parseBatchVerdicts('{"verdicts":[{"claim":1,"refuted":false}]}', 3);
    assert.equal(parsed[0]?.refuted, false);
    assert.equal(parsed[1]?.refuted, true);
    assert.equal(parsed[2]?.refuted, true);
  });

  it("treats unparseable output as a full refusal to vouch", () => {
    const parsed = parseBatchVerdicts("the model wrote prose instead", 2);
    assert.deepEqual(
      parsed.map((verdict) => verdict.refuted),
      [true, true],
    );
  });

  it("ignores claim numbers outside the batch", () => {
    const parsed = parseBatchVerdicts('{"verdicts":[{"claim":9,"refuted":false}]}', 1);
    assert.equal(parsed[0]?.refuted, true);
  });
});

describe("round budget", () => {
  it("gives a normal diff two rounds and a large diff four", () => {
    const small = ["+++ b/a.ts", "+one", "-two"].join("\n");
    assert.equal(maxRoundsForDiff(small), DEFAULT_MAX_ROUNDS);

    const big = ["+++ b/a.ts", ...Array.from({ length: 1200 }, (_, i) => `+line ${i}`)].join("\n");
    assert.equal(maxRoundsForDiff(big), LARGE_DIFF_MAX_ROUNDS);
  });

  it("does not count file headers as changed lines", () => {
    assert.equal(countChangedLines(["--- a/x.ts", "+++ b/x.ts", "+real"].join("\n")), 1);
  });

  it("round-trips the round through the state block", () => {
    const comment = formatReviewComment({
      findings: [],
      model: "m",
      truncated: false,
      round: 2,
    });
    assert.equal(parseRound(comment), 2);
    // A comment written before rounds existed reads as zero, so the next pass
    // is round one rather than being silently capped out.
    assert.equal(parseRound("<!-- coderev -->\nold comment"), 0);
  });
});

describe("survivesPanel", () => {
  const vote = (refuted: boolean) => ({ refuted, reason: "" });

  it("keeps a finding no one refuted", () => {
    assert.equal(survivesPanel([vote(false), vote(false), vote(false)]), true);
  });

  it("keeps a finding refuted by a minority", () => {
    assert.equal(survivesPanel([vote(true), vote(false), vote(false)]), true);
  });

  it("drops a finding refuted by a majority", () => {
    assert.equal(survivesPanel([vote(true), vote(true), vote(false)]), false);
  });

  it("drops a finding when the panel is empty", () => {
    // No votes means nothing vouched for it, which must not read as consensus.
    assert.equal(survivesPanel([]), false);
  });

  it("uses an odd panel size so a majority always exists", () => {
    assert.equal(REFUTATION_PANEL_SIZE % 2, 1);
  });
});

describe("truncateDiff", () => {
  it("passes a small diff through untouched", () => {
    assert.deepEqual(truncateDiff("abc", 10), { diff: "abc", truncated: false });
  });

  it("flags truncation so the comment can disclose it", () => {
    assert.deepEqual(truncateDiff("abcdef", 3), { diff: "abc", truncated: true });
  });
});

describe("unionCandidates", () => {
  const candidate = (file: string, title: string, source: string) =>
    ({ file, line: 5, title, detail: "d", severity: "medium", source }) as const;

  it("drops the second generator's rephrasing of the same finding", () => {
    const union = unionCandidates(
      [candidate("a.ts", "Race condition when queue count updates asynchronously", "m1")],
      [candidate("a.ts", "Async queue count update race condition", "m2")],
    );
    assert.equal(union.length, 1);
    assert.equal(union[0]?.source, "m1");
  });

  it("keeps a similar title on a different file — the defect may exist in both", () => {
    const union = unionCandidates(
      [candidate("a.ts", "Race condition when queue count updates asynchronously", "m1")],
      [candidate("b.ts", "Async queue count update race condition", "m2")],
    );
    assert.equal(union.length, 2);
  });

  it("keeps distinct findings on the same file", () => {
    const union = unionCandidates(
      [candidate("a.ts", "Handle leaked on early return", "m1")],
      [candidate("a.ts", "Wrong monitor used for scale computation", "m2")],
    );
    assert.equal(union.length, 2);
  });

  it("merges nearby quarter-similar titles and keeps the higher severity", () => {
    // Verbatim pair from a production scorecard: the same Esc-polling defect
    // posted twice in one round, once at low and once at high. A duplicate
    // must never launder a defect down to the rating that gets skimmed past.
    const low = {
      file: "src/scroll.rs",
      line: 120,
      title: "Polling may miss brief presses",
      detail: "d",
      severity: "low",
      source: "m1",
    } as const;
    const high = {
      file: "src/scroll.rs",
      line: 118,
      title: "Esc polling can miss a quick tap",
      detail: "d",
      severity: "high",
      source: "m2",
    } as const;
    const union = unionCandidates([low], [high]);
    assert.equal(union.length, 1);
    assert.equal(union[0]?.severity, "high");
  });

  it("merges divergent titles whose bodies restate the same root cause", () => {
    // From a production scorecard: pairs three lines apart with near-verbatim
    // details but different title compressions posted as two findings.
    const a = {
      file: "src/reactor.ts",
      line: 339,
      title: "Watermark entries evicted while Stop pending",
      detail:
        "TTL expiry removes the watermark entry while a queued Stop still references it, so the Stop dispatches against a missing watermark and the turn is never cancelled.",
      severity: "medium",
      source: "m1",
    } as const;
    const b = {
      file: "src/reactor.ts",
      line: 342,
      title: "LRU eviction breaks Stop cancellation",
      detail:
        "LRU eviction removes the watermark entry while a queued Stop still references it, so the Stop dispatches against a missing watermark and the turn is never cancelled.",
      severity: "high",
      source: "m2",
    } as const;
    const union = unionCandidates([a], [b]);
    assert.equal(union.length, 1);
    assert.equal(union[0]?.severity, "high");
  });

  it("does not merge quarter-similar titles that are far apart in the file", () => {
    const a = {
      file: "src/scroll.rs",
      line: 10,
      title: "Polling may miss brief presses",
      detail: "d",
      severity: "low",
      source: "m1",
    } as const;
    const b = {
      file: "src/scroll.rs",
      line: 900,
      title: "Hotkey polling misses modifier state",
      detail: "d",
      severity: "medium",
      source: "m2",
    } as const;
    assert.equal(unionCandidates([a], [b]).length, 2);
  });
});

describe("buildRefutePrompt", () => {
  const finding = {
    file: "a.rs",
    line: 1172,
    title: "state.license is never refreshed",
    detail: "d",
    severity: "high",
  } as const;

  it("places panel context between the diff and the claim", () => {
    // The shared cacheable prefix is diff + context + inventory; only the
    // claim varies per finding. Context after the claim would still be read,
    // but ahead of it every vote on the PR shares one prefix.
    const prompt = buildRefutePrompt({
      finding,
      diff: "DIFF",
      context: "fn refresh() { reload_license(); }",
      inventory: "INV",
    });
    const contextAt = prompt.indexOf("refresh()");
    assert.ok(contextAt > prompt.indexOf("DIFF"));
    assert.ok(contextAt < prompt.indexOf("Claimed finding"));
    assert.match(prompt, /for verifying claims about them/);
  });

  it("omits the context section entirely when there is none", () => {
    const prompt = buildRefutePrompt({ finding, diff: "DIFF" });
    assert.doesNotMatch(prompt, /verifying claims/);
  });
});

describe("dedupeFindings", () => {
  const finding = (file: string, title: string) =>
    ({ file, line: 10, title, detail: "d", severity: "medium" }) as const;

  it("merges the same defect reported across several files", () => {
    // Verbatim titles from a real run: one test-harness claim posted three
    // times across three test files.
    const grouped = dedupeFindings([
      finding("a.test.ts", "Windows ACP agent teardown test hangs due to .cmd shim"),
      finding("b.test.ts", "Windows ACP agent teardown test hangs due to .cmd shim"),
      finding("c.test.ts", "Cursor provider ACP teardown test hangs on Windows"),
    ]);
    assert.equal(grouped.length, 1);
    assert.equal(grouped[0]?.locations.length, 3);
  });

  it("keeps unrelated findings apart", () => {
    const grouped = dedupeFindings([
      finding("a.ts", "Empty model slug produces invalid Codex config"),
      finding("b.ts", "Web search tool type incorrectly derived from vision support"),
    ]);
    assert.equal(grouped.length, 2);
  });

  it("keeps the first title and detail as the group's face", () => {
    // Generation orders by severity, so the phrasing the model led with wins.
    const grouped = dedupeFindings([
      { file: "a.ts", line: 1, title: "Leak on close", detail: "first", severity: "high" },
      { file: "b.ts", line: 2, title: "Leak on close", detail: "second phrasing", severity: "low" },
    ]);
    assert.equal(grouped[0]?.detail, "first");
  });
});

describe("pass-over-pass state", () => {
  const finding = (file: string, title: string, severity: "high" | "medium" | "low") => ({
    file,
    line: 40,
    title,
    detail: "d",
    severity,
  });

  it("round-trips findings through the embedded state block", () => {
    const comment = formatReviewComment({
      findings: [finding("a.ts", "Unordered writes race", "high")],
      model: "m",
      truncated: false,
    });
    const previous = parsePreviousState(comment);
    assert.equal(previous?.length, 1);
    assert.partialDeepStrictEqual(previous?.[0], {
      file: "a.ts",
      title: "Unordered writes race",
      severity: "high",
    });
  });

  it("splits a re-pass into new, still-open, and evidence-based resolved", () => {
    const first = formatReviewComment({
      findings: [
        finding("a.ts", "Unordered writes race", "high"),
        finding("b.ts", "Handle leaked on early return", "medium"),
      ],
      model: "m",
      truncated: false,
    });
    // b.ts's cited region was touched by the new push; a.ts's was not.
    const second = formatReviewComment({
      findings: [finding("c.ts", "Timer never cancelled", "high")],
      model: "m",
      truncated: false,
      previous: parsePreviousState(first),
      changedLines: new Map([["b.ts", new Set([40, 41])]]),
    });
    assert.match(second, /New in this pass: 1 issue\./);
    assert.match(second, /Timer never cancelled/);
    assert.match(second, /Still open from earlier passes:/);
    assert.match(second, /Unordered writes race/);
    assert.match(second, /Resolved since the previous pass: 1\./);
  });

  it("does not mark a suppressed-but-untouched finding resolved", () => {
    // Generation suppression means open findings are never re-found; before
    // this fix a re-pass posting zero keeps falsely resolved everything. An
    // untouched cited region keeps the finding carried, and it stays in the
    // embedded state for the pass after that.
    const first = formatReviewComment({
      findings: [finding("a.ts", "Unordered writes race", "high")],
      model: "m",
      truncated: false,
    });
    const second = formatReviewComment({
      findings: [],
      model: "m",
      truncated: false,
      previous: parsePreviousState(first),
      changedLines: new Map(),
    });
    assert.match(second, /Still open from earlier passes:/);
    assert.match(second, /Unordered writes race/);
    assert.doesNotMatch(second, /Resolved since/);
    assert.equal(parsePreviousState(second)?.length, 1);
  });

  it("resolves a finding whose cited region the push touched", () => {
    const first = formatReviewComment({
      findings: [finding("a.ts", "Unordered writes race", "high")],
      model: "m",
      truncated: false,
    });
    const second = formatReviewComment({
      findings: [],
      model: "m",
      truncated: false,
      previous: parsePreviousState(first),
      changedLines: new Map([["a.ts", new Set([38])]]),
    });
    assert.match(second, /No blocking issues found\./);
    assert.match(second, /Resolved since the previous pass: 1\./);
    assert.equal(parsePreviousState(second)?.length, 0);
  });

  it("never says only 'nothing new' while findings remain open", () => {
    // Production misread: a session recorded "0 findings, clean pass" on a PR
    // where three carried findings sat below a bare "Nothing new" headline.
    const first = formatReviewComment({
      findings: [finding("a.ts", "Handoff marker invisible", "high")],
      model: "m",
      truncated: false,
    });
    const second = formatReviewComment({
      findings: [finding("a.ts", "Handoff marker invisible", "high")],
      model: "m",
      truncated: false,
      previous: parsePreviousState(first),
    });
    assert.match(second, /Nothing new in this pass; 1 finding\(s\) from the previous pass still open/);
  });

  it("returns null state from a body without a state block", () => {
    assert.equal(parsePreviousState("<!-- coderev -->\nold format comment"), null);
  });

  it("round-trips refuted candidates so drops stay dropped", () => {
    // Production: a WeakSet-clone claim refuted in one pass was re-derived
    // with new phrasing the next pass and kept 1-of-3 on the re-rolled dice.
    const comment = formatReviewComment({
      findings: [],
      model: "m",
      truncated: false,
      droppedThisPass: [
        { file: "a.ts", line: 495, title: "WeakSet duplicate check fails on clones", severity: "medium" },
      ],
    });
    const dropped = parseDroppedFindings(comment);
    assert.equal(dropped?.length, 1);
    assert.equal(dropped?.[0]?.title, "WeakSet duplicate check fails on clones");
    // Kept-findings parsing is unaffected by the dropped list.
    assert.deepEqual(parsePreviousState(comment), []);
  });

  it("round-trips the reviewed diff hash for the skip check", () => {
    const comment = formatReviewComment({
      findings: [],
      model: "m",
      truncated: false,
      diffHash: "abc123",
    });
    assert.equal(parseStoredDiffHash(comment), "abc123");
    // Pre-hash comments must read as "unknown", never as a match.
    const older = formatReviewComment({ findings: [], model: "m", truncated: false });
    assert.equal(parseStoredDiffHash(older), null);
  });
});

describe("formatReviewComment", () => {
  it("renders the agent fix prompt and quick-win tag", () => {
    const comment = formatReviewComment({
      findings: [
        {
          file: "a.ts",
          line: 12,
          title: "Stale telemetry overwrite",
          detail: "Older fiber can emit after newer.",
          severity: "high",
          effort: "quick",
          fix: "Track a monotonic generation and discard older completions; add a reverse-order test.",
        },
      ],
      model: "m",
      truncated: false,
    });
    assert.match(comment, /quick win/);
    assert.match(comment, /Prompt for AI agents/);
    assert.match(comment, /monotonic generation/);
    assert.match(comment, /Verify against the current code first/);
  });

  it("tells coding agents the pacing protocol in every comment", () => {
    // Delivered globally through the comment because the comment is what the
    // PR-authoring agents actually read; the alternative was pasting the same
    // rule into every repo's AGENTS.md.
    const comment = formatReviewComment({ findings: [], model: "m", truncated: false });
    assert.match(comment, /never exceed one CodeRev fix round per PR/);
  });

  it("carries a marker so the comment can be found later", () => {
    const comment = formatReviewComment({ findings: [], model: "m", truncated: false });
    assert.ok(comment.startsWith(REVIEW_COMMENT_MARKER));
  });

  it("says so plainly when nothing survived", () => {
    const comment = formatReviewComment({ findings: [], model: "m", truncated: false });
    assert.match(comment, /No blocking issues found\./);
  });

  it("renders file and line for each finding", () => {
    const comment = formatReviewComment({
      findings: [{ file: "a.ts", line: 12, title: "Leak", detail: "Handle never closed.", severity: "medium" }],
      model: "m",
      truncated: false,
    });
    assert.match(comment, /Found 1 issue:/);
    assert.match(comment, /`a\.ts`:12/);
    assert.match(comment, /Handle never closed\./);
  });

  it("omits the line suffix when the model gave no line", () => {
    const comment = formatReviewComment({
      findings: [{ file: "a.ts", line: 0, title: "Leak", detail: "", severity: "low" }],
      model: "m",
      truncated: false,
    });
    assert.match(comment, /`a\.ts`/);
    assert.doesNotMatch(comment, /:0/);
  });

  it("renders severity and orders high above low regardless of arrival order", () => {
    const comment = formatReviewComment({
      findings: [
        { file: "b.ts", line: 2, title: "Doc mismatch", detail: "", severity: "low" },
        { file: "a.ts", line: 1, title: "Data loss", detail: "", severity: "high" },
      ],
      model: "m",
      truncated: false,
    });
    assert.match(comment, /severity: high/);
    // The gate-relevant finding must lead the list.
    assert.ok(comment.indexOf("Data loss") < comment.indexOf("Doc mismatch"));
  });

  it("renders and sorts disposition before severity", () => {
    const comment = formatReviewComment({
      findings: [
        { file: "a.ts", line: 1, title: "Severe follow-up", detail: "", severity: "high", confidence: "high", disposition: "follow-up" },
        { file: "b.ts", line: 2, title: "Small blocker", detail: "", severity: "low", confidence: "medium", disposition: "block" },
      ],
      model: "m",
      truncated: false,
    });
    assert.match(comment, /disposition: block \u00b7 confidence: medium \u00b7 severity: low/);
    assert.ok(comment.indexOf("Small blocker") < comment.indexOf("Severe follow-up"));
    assert.match(comment, /fix BLOCK and FIX IF QUICK findings now/);
  });

  it("discloses truncation rather than silently reviewing part of a diff", () => {
    const comment = formatReviewComment({ findings: [], model: "m", truncated: true });
    assert.match(comment, /truncated/);
  });
});
