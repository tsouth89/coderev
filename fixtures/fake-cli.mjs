let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;

if (process.argv.includes("--empty")) {
  // Successful process with no completion must not become a clean review.
} else if (!prompt.includes("SYSTEM SENTINEL") || !prompt.includes("USER SENTINEL")) {
  process.stderr.write("expected both prompts on stdin\n");
  process.exitCode = 2;
} else {
  process.stdout.write('{"findings":[]}\n');
}
