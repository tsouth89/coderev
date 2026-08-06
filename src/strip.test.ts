import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { stripGeneratedHunks } from "./review.ts";

const hunk = (path: string, body: string) =>
  `diff --git a/${path} b/${path}\nindex 111..222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${body}\n`;

describe("stripGeneratedHunks", () => {
  it("drops lockfile hunks and discloses them", () => {
    // Production shipped a severity:high on line 1000 of a pnpm-lock.yaml — a
    // machine-written file — after billing its thousand-line hunk into every
    // panel vote.
    const diff = hunk("src/a.ts", "+real change") + hunk("pnpm-lock.yaml", "+dep bump");
    const result = stripGeneratedHunks(diff);
    assert.deepEqual(result.stripped, ["pnpm-lock.yaml"]);
    assert.match(result.diff, /Generated files changed but omitted/);
    assert.match(result.diff, /real change/);
    assert.doesNotMatch(result.diff, /dep bump/);
  });

  it("matches lockfiles in subdirectories", () => {
    const diff = hunk("apps/desktop-tauri/pnpm-lock.yaml", "+x") + hunk("rust/Cargo.lock", "+y");
    assert.deepEqual(stripGeneratedHunks(diff).stripped, [
      "apps/desktop-tauri/pnpm-lock.yaml",
      "rust/Cargo.lock",
    ]);
  });

  it("leaves a diff with no generated files byte-identical", () => {
    const diff = hunk("src/a.ts", "+x") + hunk("docs/readme.md", "+y");
    const result = stripGeneratedHunks(diff);
    assert.equal(result.diff, diff);
    assert.deepEqual(result.stripped, []);
  });

  it("does not strip files that merely contain 'lock' in the name", () => {
    const diff = hunk("src/locking.ts", "+x") + hunk("src/Sherlock.md", "+y");
    assert.deepEqual(stripGeneratedHunks(diff).stripped, []);
  });
});
