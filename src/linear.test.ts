import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { eligibleLinearFollowUps } from "./linear.ts";
import type { GroupedFinding } from "./review.ts";

const finding = (overrides: Partial<GroupedFinding>): GroupedFinding => ({
  title: "Deferred race",
  detail: "A real mechanism.",
  severity: "medium",
  locations: [{ file: "a.ts", line: 4 }],
  ...overrides,
});

describe("eligibleLinearFollowUps", () => {
  it("requires both follow-up disposition and high confidence", () => {
    const eligible = finding({ disposition: "follow-up", confidence: "high" });
    assert.deepEqual(
      eligibleLinearFollowUps([
        eligible,
        finding({ disposition: "follow-up", confidence: "medium" }),
        finding({ disposition: "block", confidence: "high" }),
        finding({ disposition: "follow-up" }),
      ]),
      [eligible],
    );
  });
});
