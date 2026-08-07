#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { parse, reportFailure, requireString } from "../src/args.ts";
import { fetchPullRequestContext } from "../src/context.ts";
import { buildFileInventory } from "../src/inventory.ts";
import {
  createInlinePullRequestReview,
  fetchExistingReviewComment,
  fetchPullRequestDiff,
  upsertPullRequestComment,
} from "../src/github.ts";
import {
  estimateCostUsd,
  resolveFind2Provider,
  resolveRefuteProvider,
  resolveReviewProvider,
} from "../src/provider.ts";
import { SEVERITY_ORDER } from "../src/review.ts";
import { createHash } from "node:crypto";
import {
  classifyAgainstPrevious,
  dedupeFindings,
  formatReviewComment,
  parseCommentableLines,
  parsePreviousState,
  parseStoredDiffHash,
  planInlineComments,
  reviewDiff,
  stripGeneratedHunks,
  truncateDiff,
  MAX_DIFF_CHARACTERS,
  REVIEW_COMMENT_MARKER,
} from "../src/review.ts";

const USAGE = `CodeRev: review a pull request diff with a cheap model and report what survives.

Usage:
  coderev --pr <number|url> [--post] [--conventions <path>] [--repo <dir>]

Flags:
  --pr           Pull request number or URL to review. Required.
  --post         Post the review as a PR comment instead of printing it.
  --conventions  Path to a conventions file to include in the prompt (e.g. AGENTS.md).
  --repo         Directory of the repository to review. Defaults to the working directory.
  --context      Also fetch full changed-file contents and feed them to the find stage.
  --summary-only Skip inline file/line comments; post only the summary comment.
  --force        Review even when the diff is identical to the last reviewed
                 push. Without it, an unchanged diff skips the review: same
                 input, same config would buy the same findings twice.
  --gate         Exit 3 when a surviving finding meets this severity (high,
                 medium, or low). Infra/provider failures exit 0 under a gate
                 (fail-open): a blocking check must block on findings, never
                 on outages. Without --gate, behaviour is advisory as before.

Environment:
  REVIEW_API_KEY       Model API key. Falls back to the provider's own variable.
  REVIEW_PROVIDER      deepseek (default), openrouter, openai.
  REVIEW_MODEL         Overrides the provider's default model.
  REVIEW_API_BASE_URL  Overrides the base URL for any OpenAI-compatible endpoint.

  REVIEW_REFUTE_PROVIDER / REVIEW_REFUTE_MODEL / REVIEW_REFUTE_API_KEY
                       Route the refutation panel to a different provider than
                       generation (hybrid mode). Unset = same provider.

  REVIEW_FIND2_PROVIDER / REVIEW_FIND2_MODEL / REVIEW_FIND2_API_KEY
                       Add a second generator (dual-generator mode); its
                       candidates union with the primary's before the panel.
                       Misconfiguration degrades to single-generator with a
                       warning rather than failing the review.`;

async function main(): Promise<number> {
  const { values, help } = parse({
    argv: process.argv.slice(2),
    options: {
      pr: { type: "string" },
      post: { type: "boolean", default: false },
      conventions: { type: "string" },
      repo: { type: "string" },
      context: { type: "boolean", default: false },
      "summary-only": { type: "boolean", default: false },
      gate: { type: "string" },
      force: { type: "boolean", default: false },
    },
    usage: USAGE,
  });

  if (help) {
    console.log(USAGE);
    return 0;
  }

  const pr = requireString(values, "pr", USAGE);
  const cwd = typeof values.repo === "string" ? values.repo : undefined;

  const resolution = resolveReviewProvider(process.env);
  if (!resolution.ok) throw new Error(resolution.reason);
  const provider = resolution.provider;

  const refuteResolution = resolveRefuteProvider(process.env);
  if (refuteResolution !== null && !refuteResolution.ok) throw new Error(refuteResolution.reason);
  const refuteProvider = refuteResolution?.ok ? refuteResolution.provider : undefined;

  // Degrade rather than fail: a fleet workflow may declare the second
  // generator before its key secret exists, and an enhancement must never turn
  // a working review into a broken one.
  const find2Resolution = resolveFind2Provider(process.env);
  if (find2Resolution !== null && !find2Resolution.ok) {
    console.warn(`Second generator disabled: ${find2Resolution.reason}`);
  }
  const find2Provider = find2Resolution?.ok ? find2Resolution.provider : undefined;

  const rawDiff = await fetchPullRequestDiff(pr, cwd);
  if (rawDiff.trim().length === 0) {
    console.log("Empty diff; nothing to review.");
    return 0;
  }

  const { diff: strippedDiff, stripped } = stripGeneratedHunks(rawDiff);
  if (stripped.length > 0) {
    console.log(`Omitting generated files from review: ${stripped.join(", ")}`);
  }
  const { diff, truncated } = truncateDiff(strippedDiff);
  if (truncated) console.warn(`Diff truncated to ${MAX_DIFF_CHARACTERS} characters.`);

  const conventions =
    typeof values.conventions === "string"
      ? await readFile(values.conventions, "utf8").catch(() => {
          // A missing conventions file weakens the review but must not fail it.
          console.warn(`Could not read ${String(values.conventions)}; continuing without it.`);
          return null;
        })
      : null;

  // Fetched once, used twice: the panel always gets it (verification evidence
  // for claims about nearby code), the generator only behind --context.
  const fullContext = await fetchPullRequestContext(pr, cwd, (message) => console.log(message));
  const context = values.context === true ? fullContext : null;

  // Always on: a few KB that closes the file-existence false-positive class.
  const inventory = await buildFileInventory(diff, cwd);

  // A push that does not change the diff (rebase, merge-from-main, CI retry)
  // re-buys nothing: the state block records what was reviewed, and reviewing
  // the same bytes again produces the same findings at full price. Fetched
  // before the review so the skip costs one API read, not one review.
  const diffHash = createHash("sha256").update(diff, "utf8").digest("hex");
  const previousBody = await fetchExistingReviewComment({
    pr,
    marker: REVIEW_COMMENT_MARKER,
    ...(cwd === undefined ? {} : { cwd }),
  });
  const previous = previousBody === null ? null : parsePreviousState(previousBody);
  if (
    values.force !== true &&
    previousBody !== null &&
    parseStoredDiffHash(previousBody) === diffHash
  ) {
    console.log("Diff unchanged since the last reviewed push; skipping (use --force to override).");
    return 0;
  }

  // Panel evidence for out-of-diff claims: read the file a finding cites from
  // the local checkout, best-effort. Three of four out-of-diff false positives
  // were refutable by the exact region the finding itself named.
  const { readFile: readFsFile } = await import("node:fs/promises");
  const { join, isAbsolute, normalize } = await import("node:path");
  const repoRoot = cwd ?? process.cwd();
  const readCitedFile = async (file: string): Promise<string | null> => {
    const normalized = normalize(file);
    if (isAbsolute(normalized) || normalized.startsWith("..")) return null;
    try {
      return await readFsFile(join(repoRoot, normalized), "utf8");
    } catch {
      return null;
    }
  };

  console.log(
    `Reviewing PR ${pr} with ${provider.model}` +
      (find2Provider ? ` + ${find2Provider.model}` : "") +
      (refuteProvider ? ` (panel: ${refuteProvider.model})` : "") +
      "...",
  );
  const { findings, usage, findUsage, find2Usage, panelUsage, generationError } = await reviewDiff({
    diff,
    conventions,
    context,
    panelContext: fullContext,
    inventory,
    provider,
    readCitedFile,
    ...(find2Provider ? { find2Provider } : {}),
    ...(refuteProvider ? { refuteProvider } : {}),
    onProgress: (message) => console.log(message),
  });

  // With hybrid routing the stages bill at different rates; summing per-stage
  // estimates is the only honest total. Either stage unknown -> total unknown.
  const findCost = estimateCostUsd(provider.model, findUsage, process.env);
  const find2Cost = find2Provider
    ? estimateCostUsd(find2Provider.model, find2Usage, process.env)
    : 0;
  const panelCost = estimateCostUsd((refuteProvider ?? provider).model, panelUsage, process.env);
  const cost =
    findCost === null || panelCost === null || find2Cost === null
      ? null
      : findCost + find2Cost + panelCost;
  console.log(
    `Tokens: ${usage.inputTokens} in (${usage.cachedInputTokens} cached), ${usage.outputTokens} out` +
      (cost === null ? "" : ` (~$${cost.toFixed(4)})`),
  );

  const gate = typeof values.gate === "string" ? values.gate.trim().toLowerCase() : "";
  if (gate !== "" && gate !== "high" && gate !== "medium" && gate !== "low") {
    throw new Error(`--gate must be high, medium, or low, not "${gate}"`);
  }

  // A failed review must never be posted or reported as a pass. Advisory mode
  // exits non-zero so the red job says "did not run". Under a gate the same
  // failure exits ZERO: a blocking check that goes red on provider outages
  // blocks every merge whenever the vendor hiccups, which is the incumbent's
  // failure mode with the sign flipped. Fail-open, loudly.
  if (generationError !== null) {
    if (gate !== "") {
      console.error(`Review did not run (${generationError}); gate is fail-open, not blocking.`);
      return 0;
    }
    throw new Error(`Review did not run: ${generationError}`);
  }

  const comment = formatReviewComment({
    findings,
    model: provider.model,
    ...(find2Provider ? { find2Model: find2Provider.model } : {}),
    ...(refuteProvider ? { panelModel: refuteProvider.model } : {}),
    truncated,
    previous,
    diffHash,
  });
  if (values.post !== true) {
    console.log(`\n${comment}`);
    return 0;
  }

  const outcome = await upsertPullRequestComment({
    pr,
    marker: REVIEW_COMMENT_MARKER,
    body: comment,
    ...(cwd === undefined ? {} : { cwd }),
  });
  console.log(
    `${outcome === "updated" ? "Updated the review comment" : "Posted a review comment"} on PR ${pr} (${findings.length} finding(s)).`,
  );

  // Inline comments: fresh findings only (a re-posted inline for a finding the
  // author already read is spam with an anchor), validated against the RAW
  // diff since that is what GitHub accepts anchors on. Any failure degrades to
  // the summary that just posted — inline is presentation, not the record.
  if (values["summary-only"] !== true && findings.length > 0) {
    const { fresh } = classifyAgainstPrevious(dedupeFindings(findings), previous);
    const { anchored, unanchored } = planInlineComments(fresh, parseCommentableLines(rawDiff));
    if (unanchored.length > 0) {
      console.log(`${unanchored.length} finding(s) had no diff anchor; summary only.`);
    }
    if (anchored.length > 0) {
      try {
        await createInlinePullRequestReview({
          pr,
          comments: anchored,
          ...(cwd === undefined ? {} : { cwd }),
        });
        console.log(`Posted ${anchored.length} inline comment(s).`);
      } catch (cause) {
        console.warn(
          `Inline comments failed, summary stands: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
  }

  if (gate !== "") {
    const threshold = gate as "high" | "medium" | "low";
    const blocking = findings.filter(
      (finding) => SEVERITY_ORDER[finding.severity] <= SEVERITY_ORDER[threshold],
    );
    if (blocking.length > 0) {
      console.error(
        `Gate: ${blocking.length} finding(s) at or above severity "${threshold}" — failing the check.`,
      );
      return 3;
    }
  }
  return 0;
}

process.exitCode = await main().catch(reportFailure);
