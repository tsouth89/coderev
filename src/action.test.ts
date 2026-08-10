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

  it("keeps Grok prompt-file mode unable to execute tools without a conflicting turn cap", () => {
    const wrapper = readFileSync(resolve(repoRoot, "bin", "grok-stdin.ps1"), "utf8");
    const invocation = wrapper
      .split(/\r?\n/)
      .find((line) => line.trimStart().startsWith("& grok "));

    assert.ok(invocation, "the wrapper must invoke Grok");
    assert.match(invocation, /--prompt-file \$promptPath/);
    assert.doesNotMatch(invocation, /--max-turns/);
    assert.match(invocation, /--tools none/);
    assert.match(invocation, /--permission-mode dontAsk/);
    assert.match(invocation, /--disable-web-search/);
    assert.match(invocation, /--no-subagents/);
    assert.match(invocation, /--no-memory/);
    assert.match(invocation, /--verbatim/);
  });
});
