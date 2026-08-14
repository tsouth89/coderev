#!/usr/bin/env node
/**
 * Fleet status for the self-hosted review runners.
 *
 * Reviews run on a handful of Windows runners on one machine, and the only way
 * to answer "is anything actually happening" was to open four GitHub tabs and
 * a task manager. This prints the whole picture in one screen: which runners
 * are alive, what each repo is reviewing right now and for how long, which
 * agent processes exist, and how the last few reviews turned out.
 *
 * Read-only by default. `--kill-stale` is the one action it offers, because
 * orphaned agent processes outliving their review is a failure this fleet has
 * actually had — one held a runner for forty-seven minutes.
 *
 * Usage:
 *   node bin/fleet.ts                 one snapshot
 *   node bin/fleet.ts --watch         refresh every 20s
 *   node bin/fleet.ts --kill-stale    kill agent processes older than 25m
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const REPOS = ["ceiling", "toolport", "cubby-clipboard", "matteshot"] as const;
const OWNER = "tsouth89";
const STALE_MINUTES = 25;

const DIM = "[2m";
const BOLD = "[1m";
const RED = "[31m";
const GREEN = "[32m";
const YELLOW = "[33m";
const RESET = "[0m";

async function gh(args: ReadonlyArray<string>): Promise<string> {
  try {
    const { stdout } = await run("gh", [...args], { maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch {
    // A failed query must not blank the whole dashboard: the other repos are
    // still worth showing.
    return "";
  }
}

function minutesSince(iso: string): number {
  const then = Date.parse(iso);
  return Number.isFinite(then) ? Math.round((Date.now() - then) / 60000) : 0;
}

interface RunnerRow {
  readonly name: string;
  readonly online: boolean;
  readonly busy: boolean;
}

interface RunRow {
  readonly id: string;
  readonly branch: string;
  readonly status: string;
  readonly conclusion: string;
  readonly minutes: number;
}

async function repoSnapshot(repo: string) {
  const [runnersRaw, activeRaw, recentRaw] = await Promise.all([
    gh(["api", `repos/${OWNER}/${repo}/actions/runners`, "--jq", ".runners[] | [.name, .status, .busy] | @tsv"]),
    gh([
      "run", "list", "-R", `${OWNER}/${repo}`, "--workflow", "PR review",
      "--limit", "20", "--json", "databaseId,status,conclusion,headBranch,createdAt",
      "--jq", '.[] | select(.status != "completed") | [.databaseId, .status, "-", .headBranch, .createdAt] | @tsv',
    ]),
    gh([
      "run", "list", "-R", `${OWNER}/${repo}`, "--workflow", "PR review",
      "--limit", "4", "--json", "databaseId,status,conclusion,headBranch,createdAt,updatedAt",
      "--jq", '.[] | select(.status == "completed") | [.databaseId, .conclusion, .headBranch, .createdAt, .updatedAt] | @tsv',
    ]),
  ]);

  const runners: Array<RunnerRow> = runnersRaw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [name, status, busy] = line.split("\t");
      return { name: name ?? "?", online: status === "online", busy: busy === "true" };
    })
    .filter((runner) => runner.name.includes("grok"));

  const active: Array<RunRow> = activeRaw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [id, status, , branch, createdAt] = line.split("\t");
      return {
        id: id ?? "?",
        branch: branch ?? "?",
        status: status ?? "?",
        conclusion: "-",
        minutes: minutesSince(createdAt ?? ""),
      };
    });

  const recent = recentRaw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [id, conclusion, branch, createdAt, updatedAt] = line.split("\t");
      const took = Math.max(0, Math.round((Date.parse(updatedAt ?? "") - Date.parse(createdAt ?? "")) / 60000));
      return { id: id ?? "?", conclusion: conclusion ?? "?", branch: branch ?? "?", took };
    });

  return { repo, runners, active, recent };
}

async function agentProcesses(): Promise<Array<{ pid: number; minutes: number }>> {
  if (process.platform !== "win32") return [];
  try {
    const { stdout } = await run("powershell", [
      "-NoProfile",
      "-Command",
      "$n=Get-Date; Get-Process -Name 'grok*' -ErrorAction SilentlyContinue | " +
        "ForEach-Object { '{0} {1}' -f $_.Id, [int]($n - $_.StartTime).TotalMinutes }",
    ]);
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [pid, minutes] = line.split(/\s+/);
        return { pid: Number(pid), minutes: Number(minutes) };
      })
      .filter((entry) => Number.isFinite(entry.pid));
  } catch {
    return [];
  }
}

async function killStale(): Promise<void> {
  const stale = (await agentProcesses()).filter((entry) => entry.minutes > STALE_MINUTES);
  if (stale.length === 0) {
    console.log(`No agent process older than ${STALE_MINUTES}m.`);
    return;
  }
  for (const entry of stale) {
    // Kill the tree: the shell wrapper is the direct child, and killing only
    // that leaves the agent itself orphaned — which is how a process survived
    // its review by forty-seven minutes.
    await run("taskkill", ["/PID", String(entry.pid), "/T", "/F"]).catch(() => undefined);
    console.log(`killed pid ${entry.pid} (${entry.minutes}m)`);
  }
}

function statusMark(conclusion: string): string {
  if (conclusion === "success") return `${GREEN}ok${RESET}`;
  if (conclusion === "cancelled") return `${YELLOW}cancelled${RESET}`;
  if (conclusion === "skipped") return `${DIM}skipped${RESET}`;
  return `${RED}${conclusion}${RESET}`;
}

async function snapshot(): Promise<void> {
  const [repos, agents] = await Promise.all([
    Promise.all(REPOS.map(repoSnapshot)),
    agentProcesses(),
  ]);

  const stamp = new Date().toLocaleTimeString();
  console.log(`${BOLD}CodeRev fleet${RESET}  ${DIM}${stamp}${RESET}\n`);

  for (const { repo, runners, active, recent } of repos) {
    const online = runners.filter((runner) => runner.online).length;
    const busy = runners.filter((runner) => runner.busy).length;
    const health = online === 0 ? `${RED}no runners${RESET}` : `${online} online, ${busy} busy`;
    console.log(`${BOLD}${repo}${RESET}  ${DIM}(${health})${RESET}`);

    if (active.length === 0) {
      console.log(`  ${DIM}idle${RESET}`);
    } else {
      for (const run of active) {
        // Anything past the job ceiling is worth flagging: it will be killed
        // by GitHub rather than finishing.
        const slow = run.minutes >= 30 ? `${RED}` : run.minutes >= 15 ? `${YELLOW}` : "";
        console.log(
          `  ${slow}${run.status.padEnd(11)} ${String(run.minutes).padStart(3)}m${RESET}  ${run.branch}`,
        );
      }
    }
    const tail = recent
      .slice(0, 3)
      .map((entry) => `${statusMark(entry.conclusion)} ${entry.took}m`)
      .join("  ");
    if (tail) console.log(`  ${DIM}last:${RESET} ${tail}`);
    console.log("");
  }

  if (agents.length === 0) {
    console.log(`${DIM}no agent processes${RESET}`);
  } else {
    const parts = agents.map((entry) => {
      const colour = entry.minutes > STALE_MINUTES ? RED : entry.minutes > 15 ? YELLOW : "";
      return `${colour}${entry.pid}:${entry.minutes}m${RESET}`;
    });
    console.log(`${BOLD}agents${RESET} ${parts.join("  ")}`);
    if (agents.some((entry) => entry.minutes > STALE_MINUTES)) {
      console.log(`${DIM}  stale ones can be cleared with --kill-stale${RESET}`);
    }
  }
}

const args = new Set(process.argv.slice(2));
if (args.has("--kill-stale")) {
  await killStale();
} else if (args.has("--watch")) {
  for (;;) {
    process.stdout.write("[2J[H");
    await snapshot();
    await new Promise((resolve) => setTimeout(resolve, 20_000));
  }
} else {
  await snapshot();
}
