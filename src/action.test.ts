import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");

describe("Grok action wrapper invariants", () => {
  it("routes the grok preset through the trusted stdin wrapper", () => {
    const action = readFileSync(resolve(repoRoot, "action.yml"), "utf8");

    assert.match(action, /REVIEW_EXEC_COMMAND" == "grok"/);
    assert.match(
      action,
      /C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1\.0\\\\powershell\.exe .*grok-stdin\.ps1/,
    );
  });

  it("keeps Grok single-turn and unable to execute tools", () => {
    const wrapper = readFileSync(resolve(repoRoot, "bin", "grok-stdin.ps1"), "utf8");

    assert.match(wrapper, /--prompt-file \$promptPath/);
    assert.match(wrapper, /--max-turns 1/);
    assert.match(wrapper, /--tools none/);
    assert.match(wrapper, /--permission-mode dontAsk/);
    assert.match(wrapper, /--disable-web-search/);
    assert.match(wrapper, /--no-subagents/);
    assert.match(wrapper, /--no-memory/);
    assert.match(wrapper, /--verbatim/);
  });
});
