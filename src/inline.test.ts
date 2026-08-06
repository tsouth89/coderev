import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyAgainstPrevious,
  formatAnchorSnippet,
  parseCommentableLines,
  planInlineComments,
  type GroupedFinding,
} from "./review.ts";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -10,3 +10,4 @@ function f() {",
  " context line 10",
  "-removed old line",
  "+added line 11",
  "+added line 12",
  " context line 13",
  "@@ -50,2 +51,2 @@",
  " context 51",
  "+added 52",
  "diff --git a/gone.ts b/gone.ts",
  "--- a/gone.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-bye",
  "-bye",
].join("\n");

describe("parseCommentableLines", () => {
  it("maps added and context lines to head-side numbers, per hunk", () => {
    const lines = parseCommentableLines(DIFF);
    const a = lines.get("src/a.ts");
    // First hunk: 10 (context), 11-12 (added), 13 (context); removal advances nothing.
    for (const n of [10, 11, 12, 13, 51, 52]) assert.ok(a?.has(n), `line ${n}`);
    assert.ok(!a?.has(14), "line after hunk is not commentable");
    assert.ok(!a?.has(50), "old-side hunk start is not the new-side start");
  });

  it("skips deleted files entirely", () => {
    assert.equal(parseCommentableLines(DIFF).has("gone.ts"), false);
  });
});

describe("planInlineComments", () => {
  const grouped = (
    title: string,
    locations: Array<{ file: string; line: number }>,
  ): GroupedFinding => ({ title, detail: "d", severity: "high", locations });

  const commentable = parseCommentableLines(DIFF);

  it("anchors at the first diff-valid location and names the rest", () => {
    const plan = planInlineComments(
      [grouped("Race", [{ file: "src/a.ts", line: 999 }, { file: "src/a.ts", line: 12 }])],
      commentable,
    );
    assert.equal(plan.anchored.length, 1);
    assert.partialDeepStrictEqual(plan.anchored[0], { path: "src/a.ts", line: 12 });
    assert.match(plan.anchored[0]?.body ?? "", /Also applies to: `src\/a\.ts`:999/);
    assert.match(plan.anchored[0]?.body ?? "", /severity: high/);
  });

  it("routes findings with no valid anchor to the summary fallback", () => {
    const plan = planInlineComments(
      [
        grouped("No line", [{ file: "src/a.ts", line: 0 }]),
        grouped("Outside diff", [{ file: "other.ts", line: 5 }]),
      ],
      commentable,
    );
    assert.equal(plan.anchored.length, 0);
    assert.equal(plan.unanchored.length, 2);
  });
});

describe("formatAnchorSnippet", () => {
  const content = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");

  it("returns a numbered window around the cited line", () => {
    const snippet = formatAnchorSnippet({ file: "a.ts", line: 100, content });
    assert.match(snippet ?? "", /around the cited line 100/);
    assert.match(snippet ?? "", /^40: line 40$/m);
    assert.match(snippet ?? "", /^160: line 160$/m);
    assert.doesNotMatch(snippet ?? "", /^39: /m);
    assert.doesNotMatch(snippet ?? "", /^161: /m);
  });

  it("clamps the window at file boundaries", () => {
    const snippet = formatAnchorSnippet({ file: "a.ts", line: 3, content });
    assert.match(snippet ?? "", /^1: line 1$/m);
  });

  it("returns null for a cited line past end of file or line zero", () => {
    // A stale line number must produce no evidence rather than the wrong
    // region presented as the right one.
    assert.equal(formatAnchorSnippet({ file: "a.ts", line: 999, content }), null);
    assert.equal(formatAnchorSnippet({ file: "a.ts", line: 0, content }), null);
  });
});

describe("classifyAgainstPrevious", () => {
  const finding = (file: string, title: string): GroupedFinding => ({
    title,
    detail: "d",
    severity: "medium",
    locations: [{ file, line: 3 }],
  });

  it("treats everything as fresh on a first pass", () => {
    const result = classifyAgainstPrevious([finding("a.ts", "Leak on close")], null);
    assert.equal(result.fresh.length, 1);
    assert.equal(result.carried.length, 0);
  });

  it("carries rephrased repeats and resolves what disappeared", () => {
    const previous = [
      { file: "a.ts", line: 3, title: "Leak on close", severity: "medium" as const },
      { file: "b.ts", line: 9, title: "Timer never cancelled", severity: "high" as const },
    ];
    const result = classifyAgainstPrevious(
      [finding("a.ts", "Close-path leak"), finding("c.ts", "Wrong monitor used")],
      previous,
    );
    assert.deepEqual(
      {
        fresh: result.fresh.map((entry) => entry.title),
        carried: result.carried.map((entry) => entry.title),
        resolved: result.resolved.map((entry) => entry.title),
      },
      {
        fresh: ["Wrong monitor used"],
        carried: ["Close-path leak"],
        resolved: ["Timer never cancelled"],
      },
    );
  });
});
