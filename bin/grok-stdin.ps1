$ErrorActionPreference = "Stop"

$promptText = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($promptText)) {
    Write-Error "CodeRev supplied an empty prompt."
    exit 2
}

$promptPath = Join-Path ([IO.Path]::GetTempPath()) ("coderev-grok-{0}.txt" -f [guid]::NewGuid())
$exitCode = 1
try {
    [IO.File]::WriteAllText($promptPath, $promptText, [Text.UTF8Encoding]::new($false))
    # --prompt-file is already single-turn. The current CLI exits 1 with
    # "Max turns reached" when that mode is also capped at --max-turns 1.
    & grok --prompt-file $promptPath --output-format plain --tools none --permission-mode dontAsk --disable-web-search --no-subagents --no-memory --verbatim
    $exitCode = $LASTEXITCODE
} catch {
    Write-Error $_
} finally {
    Remove-Item -LiteralPath $promptPath -Force -ErrorAction SilentlyContinue
}

exit $exitCode
