/**
 * Thin wrapper over the `gh` CLI.
 *
 * Uses `gh` rather than the REST API directly because it already resolves the
 * repository from the working directory, handles token auth from either
 * `GH_TOKEN` or a local login, and is present on every GitHub-hosted runner.
 * Reimplementing that to save one dependency that is already installed would be
 * a poor trade.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class GhError extends Error {
  constructor(command: string, detail: string) {
    super(`gh ${command} failed: ${detail}`);
    this.name = "GhError";
  }
}

/** Diffs can be large, so allow well past the default 1MB stdout cap. */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

async function gh(args: ReadonlyArray<string>, cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", [...args], {
      maxBuffer: MAX_BUFFER_BYTES,
      ...(cwd === undefined ? {} : { cwd }),
    });
    return stdout;
  } catch (cause) {
    const stderr =
      typeof cause === "object" && cause !== null && "stderr" in cause
        ? String((cause as { stderr: unknown }).stderr)
        : String(cause);
    throw new GhError(args[0] ?? "", stderr.slice(0, 500));
  }
}

export function fetchPullRequestDiff(pr: string, cwd?: string): Promise<string> {
  return gh(["pr", "diff", pr], cwd);
}

export async function postPullRequestComment(
  pr: string,
  body: string,
  cwd?: string,
): Promise<void> {
  await gh(["pr", "comment", pr, "--body", body], cwd);
}
