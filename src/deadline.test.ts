import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { REVIEW_DEADLINE_MS, reviewDeadlineMs, startReviewDeadline } from "./deadline.ts";

describe("review deadline", () => {
  it("defaults to thirty minutes", () => {
    assert.equal(REVIEW_DEADLINE_MS, 1_800_000);
    assert.equal(reviewDeadlineMs({}), 1_800_000);
    assert.equal(reviewDeadlineMs({ REVIEW_DEADLINE_MS: "" }), 1_800_000);
  });

  it("takes an explicit override", () => {
    assert.equal(reviewDeadlineMs({ REVIEW_DEADLINE_MS: "60000" }), 60_000);
    assert.equal(reviewDeadlineMs({ REVIEW_DEADLINE_MS: " 60000 " }), 60_000);
  });

  it("keeps the ceiling when the override is not a number", () => {
    // A typo in a workflow file must not be the thing that removes the only
    // bound on how long a review may hold a runner.
    assert.equal(reviewDeadlineMs({ REVIEW_DEADLINE_MS: "thirty" }), 1_800_000);
  });

  it("treats zero and negatives as disabled", () => {
    assert.equal(reviewDeadlineMs({ REVIEW_DEADLINE_MS: "0" }), 0);
    let killed = false;
    const deadline = startReviewDeadline({ ms: 0, kill: () => (killed = true) });
    deadline.cancel();
    assert.equal(killed, false);
  });

  it("kills the process tree when the ceiling passes", async () => {
    const previousExitCode = process.exitCode;
    let killed = 0;
    const expired: number[] = [];
    startReviewDeadline({ ms: 5, kill: () => (killed += 1), onExpire: (ms) => expired.push(ms) });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(killed, 1);
    assert.deepEqual(expired, [5]);
    assert.equal(process.exitCode, 1);
    process.exitCode = previousExitCode;
  });

  it("does not fire once cancelled", async () => {
    let killed = 0;
    const deadline = startReviewDeadline({ ms: 5, kill: () => (killed += 1), onExpire: () => {} });
    deadline.cancel();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(killed, 0);
  });
});
