#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { parse, reportFailure, requireString } from "../src/args.ts";
import {
  formatBenchmarkReport,
  parseBenchmarkSuite,
  runBenchmark,
} from "../src/benchmark.ts";
import { resolveReviewProvider } from "../src/provider.ts";

const USAGE = `CodeRev benchmark: score review models on recorded pull requests for cost and baseline agreement.

Usage:
  coderev-benchmark --suite <path> [--model <name>]... [--limit <n>] [--repo <dir>]

Flags:
  --suite  Path to a benchmark suite JSON file. Required.
           See fixtures/toolport-studio.json for the format.
  --model  Model to benchmark. Repeat to compare several. Defaults to REVIEW_MODEL.
  --limit  Benchmark only the first N recorded pull requests.
  --repo   Directory of the repository the suite refers to. Defaults to the working directory.
  --context  Also fetch full changed-file contents and feed them to the find stage.

Environment: same as coderev.

Cost is measured from reported token usage, not estimated from diff size.
Agreement with the baseline is not correctness; unmatched findings need a human read.`;

async function main(): Promise<number> {
  const { values, help } = parse({
    argv: process.argv.slice(2),
    options: {
      suite: { type: "string" },
      model: { type: "string", multiple: true },
      limit: { type: "string" },
      repo: { type: "string" },
      context: { type: "boolean", default: false },
    },
    usage: USAGE,
  });

  if (help) {
    console.log(USAGE);
    return 0;
  }

  const suitePath = requireString(values, "suite", USAGE);
  const suite = parseBenchmarkSuite(JSON.parse(await readFile(suitePath, "utf8")));

  const resolution = resolveReviewProvider(process.env);
  if (!resolution.ok) throw new Error(resolution.reason);

  const parsedLimit = Number(values.limit);
  const scores = await runBenchmark({
    suite,
    baseProvider: resolution.provider,
    models: Array.isArray(values.model) ? values.model : [],
    limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : suite.cases.length,
    withContext: values.context === true,
    ...(typeof values.repo === "string" ? { cwd: values.repo } : {}),
    env: process.env,
    onProgress: (message) => console.log(message),
  });

  console.log(formatBenchmarkReport(suite, scores));
  return 0;
}

process.exitCode = await main().catch(reportFailure);
