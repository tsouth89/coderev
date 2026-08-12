$ErrorActionPreference = "Stop"

# Grok CLI is an AGENTIC coding agent, not a completion endpoint. Measured on
# 2026-08-10 against the real CLI:
#
#   --permission-mode dontAsk  ->  DENIES tool calls. The agent emits a
#       planning preamble (turn 1), requests a file read (turn 2), is refused,
#       and the run ends with stopReason "cancelled". Output is the preamble
#       only, which parses to zero findings. This silently produced 0 findings
#       on every fleet run for two days.
#   --tools none               ->  same outcome by a different route: the agent
#       plans to inspect the repo, has no way to, and stops.
#   --always-approve + tools   ->  works. 126s, real repo inspection, final
#       message is the requested JSON.
#
# The CLI must run with its working directory inside the repo under review:
# its value is reading surrounding code, not parsing a diff blob.
#
# Tools are auto-approved, so the sandbox is the safety boundary. Never point
# this at an untrusted checkout.

$promptText = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($promptText)) {
    Write-Error "CodeRev supplied an empty prompt."
    exit 2
}

$promptPath = Join-Path ([IO.Path]::GetTempPath()) ("coderev-grok-{0}.txt" -f [guid]::NewGuid())
$exitCode = 1
try {
    [IO.File]::WriteAllText($promptPath, $promptText, [Text.UTF8Encoding]::new($false))
# Turn budget: 80, not 20. Measured over 25 fleet runs, nine died with
# "Max turns reached" — the agent spends turns reading files, and a complex
# diff exhausts a small budget mid-inspection, producing nothing. Turns are
# not billed individually; an unfinished review is the expensive outcome.
    & grok --prompt-file $promptPath `
        --output-format plain `
        --always-approve `
        --disable-web-search `
        --no-subagents `
        --no-memory `
        --max-turns 80 `
        --verbatim
    $exitCode = $LASTEXITCODE
} catch {
    Write-Error $_
} finally {
    Remove-Item -LiteralPath $promptPath -Force -ErrorAction SilentlyContinue
}

exit $exitCode
