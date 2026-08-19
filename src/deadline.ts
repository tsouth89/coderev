import { spawn } from "node:child_process";

/**
 * Hard wall-clock ceiling on one review.
 *
 * The exec budgets in provider.ts bound a single agent call, not the review.
 * A dual-generator round plus a refutation panel is four calls, so a review
 * can hold a runner for over an hour without any single call misbehaving —
 * and on 2026-08-19 a stuck MCP handshake did exactly that across the whole
 * fleet, one fifteen-minute silent call at a time. This is the outer bound
 * that nothing negotiates with.
 *
 * Override with REVIEW_DEADLINE_MS. Zero or negative disables it, which is
 * what a local run wanting to sit in a debugger should pass.
 */
export const REVIEW_DEADLINE_MS = 1_800_000;

export function reviewDeadlineMs(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env.REVIEW_DEADLINE_MS?.trim();
  if (!raw) return REVIEW_DEADLINE_MS;
  const parsed = Number(raw);
  // A malformed override keeps the ceiling rather than removing it: a typo in
  // a workflow file must not be the thing that lets a review run forever.
  if (!Number.isFinite(parsed)) return REVIEW_DEADLINE_MS;
  return parsed;
}

/**
 * Kill this process and everything under it.
 *
 * process.exit() is not enough on Windows. An exec provider's agent is a
 * grandchild through a shell, and Windows does not reap it when the parent
 * goes: that is precisely how a grok process outlived its review by
 * forty-seven minutes. taskkill /T takes the tree.
 */
function terminateTree(): void {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(process.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    return;
  }
  process.kill(process.pid, "SIGKILL");
}

export interface ReviewDeadline {
  /** Stop the clock. Safe to call more than once. */
  readonly cancel: () => void;
}

/**
 * Arm the ceiling. Returns a handle whose cancel() releases the event loop,
 * so a review that finishes early exits at its own pace.
 */
export function startReviewDeadline(options: {
  readonly ms: number;
  readonly onExpire?: (ms: number) => void;
  readonly kill?: () => void;
}): ReviewDeadline {
  const { ms } = options;
  if (!Number.isFinite(ms) || ms <= 0) return { cancel: () => {} };

  const kill = options.kill ?? terminateTree;
  const timer = setTimeout(() => {
    const minutes = Math.round(ms / 60_000);
    (options.onExpire ?? ((): void => {
      console.error(
        `Review exceeded its ${minutes}-minute ceiling and was killed. ` +
          `Nothing was posted. Raise REVIEW_DEADLINE_MS only if a review is ` +
          `legitimately this slow — a review this long is usually a hung agent.`,
      );
    }))(ms);
    process.exitCode = 1;
    kill();
  }, ms);
  // Do not hold the process open on the timer's account.
  timer.unref();

  return {
    cancel: () => {
      clearTimeout(timer);
    },
  };
}
