import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildRefutePrompt,
  dedupeFindings,
  extractJsonObject,
  formatReviewComment,
  parseFindings,
  parseVerdict,
  REFUTATION_PANEL_SIZE,
  REVIEW_COMMENT_MARKER,
  survivesPanel,
  truncateDiff,
  unionCandidates,
} from "./review.ts";

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

describe("formatReviewComment", () => {
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

  it("discloses truncation rather than silently reviewing part of a diff", () => {
    const comment = formatReviewComment({ findings: [], model: "m", truncated: true });
    assert.match(comment, /truncated/);
  });
});
