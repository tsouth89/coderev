/**
 * A small inventory of tracked files in the directories a diff touches.
 *
 * Exists to close a measured false-positive class: static-repo-fact
 * conditionals. The confirmed case was "broken link to claude.md — if the file
 * is missing, moved, or named differently…" on a link to a file that exists.
 * The claim names a concrete trigger, so the checkability lens passes it; the
 * mechanism lens cannot check file existence because the panel sees only the
 * diff; scope passes because the link is on a changed line. Every seat did its
 * job and the finding survived, because the one refuting fact lived outside
 * everyone's evidence. Handing both stages the file listing puts that fact in
 * evidence.
 *
 * Scoped to touched directories (plus the repo root) rather than the whole
 * tree, because `git ls-files` on a repo with vendored subtrees runs to tens
 * of thousands of paths, while relative links and sibling imports — the
 * things these claims are about — overwhelmingly point at neighbours.
 *
 * Best-effort throughout: no git, no repo, or an oversized listing degrades
 * the review rather than failing it.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Per-directory and whole-inventory caps, sized to stay a rounding error in the prompt. */
export const INVENTORY_DIR_FILE_CAP = 120;
export const INVENTORY_TOTAL_CHAR_CAP = 12_000;

/** Directories touched by a unified diff, from +++ / rename headers. */
export function parseChangedDirsFromDiff(diff: string): ReadonlyArray<string> {
  const dirs = new Set<string>();
  for (const match of diff.matchAll(/^(?:\+\+\+ b\/|rename to )(.+)$/gm)) {
    const path = (match[1] ?? "").trim();
    if (path.length === 0 || path === "/dev/null") continue;
    const slash = path.lastIndexOf("/");
    dirs.add(slash === -1 ? "." : path.slice(0, slash));
  }
  return [...dirs].sort();
}

/**
 * Format the listing for the touched directories out of the full tracked-file
 * list. Directories are truncated per-file-cap and the whole block per
 * char-cap, each with an explicit note: an inventory that silently omits a
 * file would let the panel "refute" a true missing-file claim, which is the
 * exact mistake this exists to prevent, inverted.
 */
export function buildInventoryFromFileList(
  changedDirs: ReadonlyArray<string>,
  trackedFiles: ReadonlyArray<string>,
): string | null {
  if (changedDirs.length === 0 || trackedFiles.length === 0) return null;

  const byDir = new Map<string, Array<string>>();
  for (const file of trackedFiles) {
    const slash = file.lastIndexOf("/");
    const dir = slash === -1 ? "." : file.slice(0, slash);
    const name = slash === -1 ? file : file.slice(slash + 1);
    const bucket = byDir.get(dir);
    if (bucket) bucket.push(name);
    else byDir.set(dir, [name]);
  }

  const sections: Array<string> = [];
  for (const dir of changedDirs) {
    const names = byDir.get(dir);
    if (!names || names.length === 0) continue;
    const shown = names.slice(0, INVENTORY_DIR_FILE_CAP);
    const more = names.length - shown.length;
    sections.push(
      `${dir === "." ? "(repo root)" : `${dir}/`}: ${shown.join(", ")}` +
        (more > 0 ? ` …and ${more} more` : ""),
    );
  }
  if (sections.length === 0) return null;

  let body = sections.join("\n");
  if (body.length > INVENTORY_TOTAL_CHAR_CAP) {
    body = `${body.slice(0, INVENTORY_TOTAL_CHAR_CAP)}\n…(inventory truncated)`;
  }
  return [
    "Tracked files in the directories this diff touches (for resolving file and",
    "link references; directories outside this list are not shown):",
    body,
  ].join("\n");
}

/** Tracked files at the checkout, or null when git or the repo is unavailable. */
export async function fetchTrackedFiles(cwd?: string): Promise<ReadonlyArray<string> | null> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files"], {
      maxBuffer: 64 * 1024 * 1024,
      ...(cwd === undefined ? {} : { cwd }),
    });
    const files = stdout.split("\n").filter((line) => line.length > 0);
    return files.length > 0 ? files : null;
  } catch {
    return null;
  }
}

/** End-to-end: diff + checkout to inventory block, best-effort. */
export async function buildFileInventory(diff: string, cwd?: string): Promise<string | null> {
  const dirs = parseChangedDirsFromDiff(diff);
  if (dirs.length === 0) return null;
  const tracked = await fetchTrackedFiles(cwd);
  if (tracked === null) return null;
  return buildInventoryFromFileList(dirs, tracked);
}
