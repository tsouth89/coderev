import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildInventoryFromFileList,
  INVENTORY_DIR_FILE_CAP,
  parseChangedDirsFromDiff,
} from "./inventory.ts";

describe("parseChangedDirsFromDiff", () => {
  it("collects directories from +++ headers", () => {
    const diff = [
      "--- a/docs/providers/deepseek.md",
      "+++ b/docs/providers/deepseek.md",
      "@@ -1 +1 @@",
      "+++ this is content, not a header — but matches only at line start",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
    ].join("\n");
    assert.deepEqual(parseChangedDirsFromDiff(diff), ["docs/providers", "src"]);
  });

  it("maps root-level files to '.' and includes rename targets", () => {
    const diff = ["+++ b/README.md", "rename to docs/moved.md"].join("\n");
    assert.deepEqual(parseChangedDirsFromDiff(diff), [".", "docs"]);
  });

  it("ignores /dev/null from deletions", () => {
    assert.deepEqual(parseChangedDirsFromDiff("+++ /dev/null"), []);
  });
});

describe("buildInventoryFromFileList", () => {
  const tracked = [
    "README.md",
    "docs/providers/claude.md",
    "docs/providers/codex.md",
    "docs/providers/deepseek.md",
    "src/a.ts",
  ];

  it("lists sibling files for a touched directory", () => {
    // The confirmed false positive: a claim that claude.md might not exist,
    // judged by a panel that could not see the directory listing. This block
    // is the refuting evidence.
    const inventory = buildInventoryFromFileList(["docs/providers"], tracked);
    assert.match(inventory ?? "", /docs\/providers\/: claude\.md, codex\.md, deepseek\.md/);
    assert.doesNotMatch(inventory ?? "", /src/);
  });

  it("labels the repo root distinctly", () => {
    const inventory = buildInventoryFromFileList(["."], tracked);
    assert.match(inventory ?? "", /\(repo root\): README\.md/);
  });

  it("returns null rather than an empty section", () => {
    assert.equal(buildInventoryFromFileList(["missing/dir"], tracked), null);
    assert.equal(buildInventoryFromFileList([], tracked), null);
  });

  it("caps a huge directory and says so", () => {
    // Silently omitting a file would let the panel refute a TRUE missing-file
    // claim — the original mistake inverted — so truncation must be labelled.
    const many = Array.from({ length: 300 }, (_, index) => `big/f${index}.ts`);
    const inventory = buildInventoryFromFileList(["big"], many);
    assert.match(inventory ?? "", new RegExp(`and ${300 - INVENTORY_DIR_FILE_CAP} more`));
  });
});
