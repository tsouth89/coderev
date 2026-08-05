import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  extractJsonObject,
  formatReviewComment,
  parseFindings,
  parseVerdict,
  REFUTATION_PANEL_SIZE,
  REVIEW_COMMENT_MARKER,
  survivesPanel,
  truncateDiff,
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
      [{ file: "a.ts", line: 12, title: "Leak", detail: "Handle never closed." }],
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
      findings: [{ file: "a.ts", line: 12, title: "Leak", detail: "Handle never closed." }],
      model: "m",
      truncated: false,
    });
    assert.match(comment, /Found 1 issue:/);
    assert.match(comment, /`a\.ts`:12/);
    assert.match(comment, /Handle never closed\./);
  });

  it("omits the line suffix when the model gave no line", () => {
    const comment = formatReviewComment({
      findings: [{ file: "a.ts", line: 0, title: "Leak", detail: "" }],
      model: "m",
      truncated: false,
    });
    assert.match(comment, /`a\.ts`/);
    assert.doesNotMatch(comment, /:0/);
  });

  it("discloses truncation rather than silently reviewing part of a diff", () => {
    const comment = formatReviewComment({ findings: [], model: "m", truncated: true });
    assert.match(comment, /truncated/);
  });
});
