#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { parse, reportFailure, requireString } from "../src/args.ts";
import { fetchPullRequestContext } from "../src/context.ts";
import { fetchPullRequestDiff, upsertPullRequestComment } from "../src/github.ts";
import { estimateCostUsd, resolveRefuteProvider, resolveReviewProvider } from "../src/provider.ts";
import {
  formatReviewComment,
  reviewDiff,
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

Environment:
  REVIEW_API_KEY       Model API key. Falls back to the provider's own variable.
  REVIEW_PROVIDER      deepseek (default), openrouter, openai.
  REVIEW_MODEL         Overrides the provider's default model.
  REVIEW_API_BASE_URL  Overrides the base URL for any OpenAI-compatible endpoint.

  REVIEW_REFUTE_PROVIDER / REVIEW_REFUTE_MODEL / REVIEW_REFUTE_API_KEY
                       Route the refutation panel to a different provider than
                       generation (hybrid mode). Unset = same provider.`;

async function main(): Promise<number> {
  const { values, help } = parse({
    argv: process.argv.slice(2),
    options: {
      pr: { type: "string" },
      post: { type: "boolean", default: false },
      conventions: { type: "string" },
      repo: { type: "string" },
      context: { type: "boolean", default: false },
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

  const rawDiff = await fetchPullRequestDiff(pr, cwd);
  if (rawDiff.trim().length === 0) {
    console.log("Empty diff; nothing to review.");
    return 0;
  }

  const { diff, truncated } = truncateDiff(rawDiff);
  if (truncated) console.warn(`Diff truncated to ${MAX_DIFF_CHARACTERS} characters.`);

  const conventions =
    typeof values.conventions === "string"
      ? await readFile(values.conventions, "utf8").catch(() => {
          // A missing conventions file weakens the review but must not fail it.
          console.warn(`Could not read ${String(values.conventions)}; continuing without it.`);
          return null;
        })
      : null;

  const context =
    values.context === true
      ? await fetchPullRequestContext(pr, cwd, (message) => console.log(message))
      : null;

  console.log(
    `Reviewing PR ${pr} with ${provider.model}` +
      (refuteProvider ? ` (panel: ${refuteProvider.model})` : "") +
      "...",
  );
  const { findings, usage, findUsage, panelUsage, generationError } = await reviewDiff({
    diff,
    conventions,
    context,
    provider,
    ...(refuteProvider ? { refuteProvider } : {}),
    onProgress: (message) => console.log(message),
  });

  // With hybrid routing the stages bill at different rates; summing per-stage
  // estimates is the only honest total. Either stage unknown -> total unknown.
  const findCost = estimateCostUsd(provider.model, findUsage, process.env);
  const panelCost = estimateCostUsd((refuteProvider ?? provider).model, panelUsage, process.env);
  const cost = findCost === null || panelCost === null ? null : findCost + panelCost;
  console.log(
    `Tokens: ${usage.inputTokens} in (${usage.cachedInputTokens} cached), ${usage.outputTokens} out` +
      (cost === null ? "" : ` (~$${cost.toFixed(4)})`),
  );

  // A failed review must never be posted or reported as a pass. Silence is the
  // only honest output here: an empty findings list from a review that never
  // ran is indistinguishable from a clean one, and posting it would put a
  // false all-clear on the pull request.
  if (generationError !== null) {
    throw new Error(`Review did not run: ${generationError}`);
  }

  const comment = formatReviewComment({ findings, model: provider.model, truncated });
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
  return 0;
}

process.exitCode = await main().catch(reportFailure);
