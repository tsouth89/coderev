/**
 * Full contents of changed files, as extra input to the find stage.
 *
 * The benchmark's first run made the case for this. The two findings in the
 * suite most verifiably real — each traceable to a fix commit the author
 * shipped after review — were both invisible in the diff alone: an omission in
 * what `useSettingsRestore` covers, and a code path only reachable through the
 * expanded composer. A diff shows what changed; those defects live in what the
 * changed code interacts with. The paid reviewer this replaces runs scripts
 * against the checkout for the same reason.
 *
 * Context goes only to the find stage. The panel judges specific claims, its
 * prompt is shaped for prefix caching, and the grounds it accepts already
 * forbid "cannot see the rest of the codebase" as a reason to refute.
 *
 * Everything here is best-effort: a file that cannot be fetched, or one over
 * budget, degrades the review rather than failing it. The caps exist because
 * changed files can dwarf the diff (one file in the benchmark repo tops 6,000
 * lines), and an unbounded fetch would quietly turn a two-cent review into a
 * fifty-cent one.
 */
import { fetchFileAtRef, fetchPullRequestFiles } from "./github.ts";

/** Per-file and whole-PR caps, in characters (~4 chars per token). */
export const CONTEXT_PER_FILE_CAP = 48_000;
export const CONTEXT_TOTAL_CAP = 400_000;

/** Files whose contents cannot help a reviewer: binaries, lockfiles, assets. */
const SKIP_PATTERN =
  /\.(png|jpe?g|gif|ico|svg|pdf|zip|gz|woff2?|ttf|eot|otf|mp[34]|webm|wasm|min\.js|map)$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum)$/i;

export function isContextWorthy(path: string): boolean {
  return !SKIP_PATTERN.test(path);
}

export function formatContextFile(path: string, content: string): string {
  const capped = content.length > CONTEXT_PER_FILE_CAP;
  const body = capped ? content.slice(0, CONTEXT_PER_FILE_CAP) : content;
  const note = capped ? ` (truncated at ${CONTEXT_PER_FILE_CAP} characters)` : "";
  return `--- ${path}${note} ---\n${body}\n`;
}

/**
 * Assemble the context block for a pull request, or null when nothing useful
 * could be fetched. Files are taken in the order GitHub lists them until the
 * total budget runs out; files skipped for budget are named, so the model
 * knows its context is partial rather than assuming it saw everything.
 */
export async function fetchPullRequestContext(
  pr: string,
  cwd?: string,
  onProgress?: (message: string) => void,
): Promise<string | null> {
  const note = onProgress ?? (() => {});
  let files;
  try {
    files = await fetchPullRequestFiles(pr, cwd);
  } catch (cause) {
    note(`  context unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
    return null;
  }
  if (files.headSha.length === 0 || files.paths.length === 0) return null;

  const sections: Array<string> = [];
  const skippedForBudget: Array<string> = [];
  let spent = 0;

  for (const path of files.paths.filter(isContextWorthy)) {
    if (spent >= CONTEXT_TOTAL_CAP) {
      skippedForBudget.push(path);
      continue;
    }
    const content = await fetchFileAtRef(path, files.headSha, cwd);
    if (content === null) continue;
    const section = formatContextFile(path, content);
    sections.push(section);
    spent += section.length;
  }

  if (sections.length === 0) return null;
  if (skippedForBudget.length > 0) {
    sections.push(
      `--- not included (context budget reached): ${skippedForBudget.join(", ")} ---\n`,
    );
  }
  return sections.join("\n");
}
