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

  it("keeps Grok able to inspect the repo, with room to finish", () => {
    // This invariant was originally inverted: it asserted --tools none,
    // --permission-mode dontAsk, and the absence of --max-turns. Those are
    // the exact flags that made Grok contribute nothing for two days.
    // Measured against the real CLI: dontAsk DENIES tool calls rather than
    // auto-approving them, so the agent emitted a planning preamble, asked to
    // read a file, was refused, and ended with stopReason "cancelled" at exit
    // code 0 — indistinguishable from a clean review. Grok is an agentic
    // reviewer; reading the surrounding code is the whole point of using it.
    const wrapper = readFileSync(resolve(repoRoot, "bin", "grok-stdin.ps1"), "utf8");
    const invocation = wrapper
      .split(/\r?\n/)
      .filter((line) => line.trimStart().startsWith("& grok ") || line.trimStart().startsWith("--"))
      .join(" ");

    assert.ok(invocation, "the wrapper must invoke Grok");
    assert.match(invocation, /--prompt-file \$promptPath/);
    // Tools stay enabled and auto-approved, and neither disabling flag returns.
    assert.match(invocation, /--always-approve/);
    assert.doesNotMatch(invocation, /--tools none/);
    assert.doesNotMatch(invocation, /--permission-mode dontAsk/);
    // A turn budget is required, and small budgets starve the inspection:
    // nine of twenty-five fleet runs died at "Max turns reached" with 20.
    const turns = invocation.match(/--max-turns (\d+)/);
    assert.ok(turns, "the wrapper must set a turn budget");
    assert.ok(Number(turns[1]) >= 60, `turn budget too small: ${turns[1]}`);
    assert.match(invocation, /--disable-web-search/);
    // Subagents stay OFF. Enabling them hung the fleet: the extra narration
    // reset the idle timer on every chunk, so runs could only end at the total
    // cap, and one held a runner for forty-seven minutes while five pull
    // requests queued. Depth is not worth an unbounded review.
    assert.match(invocation, /--no-subagents/);
    // The model is pinned so the reviewer cannot change under us on a release.
    assert.match(invocation, /--model \$model/);
    assert.match(invocation, /--no-memory/);
    // Output is streamed, not buffered: plain mode printed nothing until the
    // agent finished, so a ten-minute review looked exactly like a hang. The
    // wrapper narrates events on stderr and prints only the final message on
    // stdout, which is why --verbatim is gone and this flag is required.
    assert.match(invocation, /--output-format streaming-messages-json/);
    assert.doesNotMatch(invocation, /--verbatim/);
  });
});
