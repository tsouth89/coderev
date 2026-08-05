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

export interface PullRequestFiles {
  readonly headSha: string;
  readonly paths: ReadonlyArray<string>;
}

/** The head SHA and changed-file paths of a pull request. */
export async function fetchPullRequestFiles(pr: string, cwd?: string): Promise<PullRequestFiles> {
  const raw = await gh(["pr", "view", pr, "--json", "headRefOid,files"], cwd);
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) throw new GhError("pr", "unexpected shape");
  const record = parsed as Record<string, unknown>;
  const headSha = typeof record.headRefOid === "string" ? record.headRefOid : "";
  const files = Array.isArray(record.files) ? record.files : [];
  const paths = files.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const path = (entry as Record<string, unknown>).path;
    return typeof path === "string" ? [path] : [];
  });
  return { headSha, paths };
}

/**
 * Fetch one file's raw content at a specific commit, via the GitHub API rather
 * than the local checkout. Merged pull requests routinely have their branches
 * deleted, so the head commit may not exist locally, but GitHub retains it.
 * Returns null for anything unfetchable (deleted file, binary, too large):
 * context is best-effort by design, and a missing file must degrade the review
 * rather than fail it.
 */
export async function fetchFileAtRef(
  path: string,
  ref: string,
  cwd?: string,
): Promise<string | null> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  try {
    return await gh(
      [
        "api",
        "-H",
        "Accept: application/vnd.github.raw",
        `repos/{owner}/{repo}/contents/${encoded}?ref=${ref}`,
      ],
      cwd,
    );
  } catch {
    return null;
  }
}

export async function postPullRequestComment(
  pr: string,
  body: string,
  cwd?: string,
): Promise<void> {
  await gh(["pr", "comment", pr, "--body", body], cwd);
}

/** Resolve a PR number or URL to its number, for issue-comment API calls. */
export async function resolvePullRequestNumber(pr: string, cwd?: string): Promise<number> {
  const raw = await gh(["pr", "view", pr, "--json", "number"], cwd);
  const parsed: unknown = JSON.parse(raw);
  const number =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>).number
      : undefined;
  if (typeof number !== "number") throw new GhError("pr", "could not resolve PR number");
  return number;
}

/**
 * Post the review comment, or edit the existing one in place.
 *
 * A review that posts a fresh comment on every push turns an active pull
 * request into a wall of stale reviews: four pushes, four comments, three of
 * them describing code that no longer exists. The marker at the top of every
 * review comment exists so this function can find its predecessor; one
 * up-to-date comment is the whole point of re-reviewing on synchronize.
 */
export async function upsertPullRequestComment(input: {
  readonly pr: string;
  readonly marker: string;
  readonly body: string;
  readonly cwd?: string;
}): Promise<"created" | "updated"> {
  const number = await resolvePullRequestNumber(input.pr, input.cwd);
  // Server-side filter: only matching comment ids come back, not every body.
  const existing = await gh(
    [
      "api",
      `repos/{owner}/{repo}/issues/${number}/comments?per_page=100`,
      "--paginate",
      "--jq",
      `.[] | select(.body | startswith("${input.marker}")) | .id`,
    ],
    input.cwd,
  );
  const firstId = existing
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^\d+$/.test(line));

  if (firstId !== undefined) {
    await gh(
      [
        "api",
        "-X",
        "PATCH",
        `repos/{owner}/{repo}/issues/comments/${firstId}`,
        "-f",
        `body=${input.body}`,
      ],
      input.cwd,
    );
    return "updated";
  }
  await gh(["pr", "comment", String(number), "--body", input.body], input.cwd);
  return "created";
}
