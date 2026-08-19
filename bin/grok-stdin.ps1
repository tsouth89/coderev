$ErrorActionPreference = "Stop"

# Grok CLI is an AGENTIC coding agent, not a completion endpoint. Measured
# against the real CLI:
#
#   --permission-mode dontAsk  ->  DENIES tool calls. The agent emits a
#       planning preamble, requests a file read, is refused, and ends with
#       stopReason "cancelled" at exit code 0 — indistinguishable from a clean
#       review. This silently produced zero findings on every fleet run for
#       two days.
#   --tools none               ->  same outcome by a different route.
#   --always-approve + tools   ->  works. The agent reads the surrounding code,
#       which is the entire reason for using it.
#
# Tools are auto-approved, so the sandbox is the safety boundary. Never point
# this at an untrusted checkout.
#
# Output is STREAMED rather than buffered. Plain mode prints nothing until the
# agent finishes, so a ten-minute review looked identical to a hang: the job
# log sat empty and the only way to know whether it was working was to wait.
# Streaming mode emits events from the first second, so this wrapper narrates
# them on stderr (which CodeRev forwards into the review log) and prints only
# the final assistant message on stdout, keeping the JSON contract unchanged.

# The reviewer runs against a REVIEW-ONLY grok home, not the interactive one.
#
# The interactive home declares MCP servers -- a Toolport gateway that fans out
# to a dozen remote servers and builds 2100+ tools on every launch. On
# 2026-08-19 that gateway stopped completing its handshake: grok logged
# `mcp_server_starting`, never logged `mcp_server_connected`, and never accepted
# the prompt. It did not honour its own startup_timeout_sec either, so the agent
# sat mute until CodeRev's idle budget killed it. Sixty-six consecutive reviews
# produced not one byte of stdout, and the job log showed nothing at all.
#
# A code reviewer needs read_file and grep, not Stripe and Linode. Isolating the
# home removes the entire class: no MCP server, no dependency on whatever the
# desktop app is doing, and a startup that does not touch the network. Only the
# credential file is shared, so a `grok login` at the terminal still authorises
# the fleet.
$personalHome = Join-Path $env:USERPROFILE ".grok"
$reviewHome = Join-Path $env:USERPROFILE ".grok-coderev"
New-Item -ItemType Directory -Path $reviewHome -Force | Out-Null

# Rewritten every run rather than seeded once: a config that drifts back to
# declaring an MCP server would reintroduce the hang silently, and the whole
# point of this file is that the reviewer's environment is not negotiable.
# auto_update is off because a 142 MB self-update inside a review is a stall,
# and the interactive home still updates the shared binary.
@'
[cli]
auto_update = false
installer = "internal"

[marketplace]
default_skills_installs_purged = true
official_marketplace_auto_installed = true

[models]
default = "grok-4.6"

[ui]
compact_mode = false
permission_mode = "always-approve"
yolo = false

[privacy]
privacy_banner_acked = "2026-08-19T00:00:00Z"
'@ | Set-Content -LiteralPath (Join-Path $reviewHome "config.toml") -Encoding utf8

$env:GROK_HOME = $reviewHome
$env:GROK_AUTH_PATH = Join-Path $personalHome "auth.json"

$promptText = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($promptText)) {
    Write-Error "CodeRev supplied an empty prompt."
    exit 2
}

$promptPath = Join-Path ([IO.Path]::GetTempPath()) ("coderev-grok-{0}.txt" -f [guid]::NewGuid())
$exitCode = 1
try {
    [IO.File]::WriteAllText($promptPath, $promptText, [Text.UTF8Encoding]::new($false))

    # Model is pinned, not inherited. `grok models` reports a default that
    # moves when a release lands, so an unpinned wrapper silently swaps
    # reviewer mid-ledger and the logs never say which model judged what.
    $model = if ($env:CODEREV_GROK_MODEL) { $env:CODEREV_GROK_MODEL } else { "grok-4.6" }

    # Subagents stay off: their narration once kept the idle timer alive on
    # every chunk, so runs only ended at the total cap and one held a runner
    # for forty-seven minutes while pull requests queued.
    $started = Get-Date
    $final = [Text.StringBuilder]::new()
    $turns = 0
    $lastNote = $started

    & grok --prompt-file $promptPath `
        --model $model `
        --output-format streaming-messages-json `
        --always-approve `
        --disable-web-search `
        --no-subagents `
        --no-memory `
        --max-turns 80 2>$null |
        ForEach-Object {
            $line = $_
            if ([string]::IsNullOrWhiteSpace($line)) { return }

            try { $event = $line | ConvertFrom-Json -ErrorAction Stop } catch { return }
            $elapsed = [int]((Get-Date) - $started).TotalSeconds

            switch ($event.type) {
                "system" {
                    if ($event.subtype -eq "init") {
                        [Console]::Error.WriteLine("grok: started on $($event.model)")
                    }
                }
                "assistant" {
                    $turns++
                    foreach ($block in $event.message.content) {
                        if ($block.type -eq "tool_use") {
                            # Name the file being inspected: this is the single
                            # most useful progress signal, because it shows the
                            # agent reading real code rather than spinning.
                            $target = $null
                            foreach ($key in @("file_path", "path", "filePath", "target_file",
                                               "pattern", "query", "command", "cmd")) {
                                if ($block.input.PSObject.Properties.Name -contains $key) {
                                    $value = $block.input.$key
                                    if ($value) { $target = $value; break }
                                }
                            }
                            if (-not $target) {
                                # Unknown tool shape: show the first scalar
                                # argument rather than nothing, so the log still
                                # says what the agent touched.
                                $first = $block.input.PSObject.Properties |
                                    Where-Object { $_.Value -is [string] -and $_.Value } |
                                    Select-Object -First 1
                                if ($first) { $target = $first.Value }
                            }
                            $shown = if ($target) { ([string]$target) } else { "" }
                            if ($shown.Length -gt 70) { $shown = $shown.Substring(0, 70) + "..." }
                            [Console]::Error.WriteLine("grok [${elapsed}s, turn $turns]: $($block.name) $shown")
                        } elseif ($block.type -eq "text" -and $block.text) {
                            [void]$final.Clear()
                            [void]$final.Append($block.text)
                        }
                    }
                }
                "result" {
                    if ($event.result) { [void]$final.Clear(); [void]$final.Append($event.result) }
                    [Console]::Error.WriteLine(
                        "grok: finished in ${elapsed}s over $turns turn(s), stop=$($event.subtype)")
                }
                default {
                    # Heartbeat at most once a minute so a long thinking pause
                    # still shows life without flooding the log.
                    if (((Get-Date) - $lastNote).TotalSeconds -ge 60) {
                        $lastNote = Get-Date
                        [Console]::Error.WriteLine("grok [${elapsed}s]: working")
                    }
                }
            }
        }

    $exitCode = $LASTEXITCODE
    if ($final.Length -gt 0) { [Console]::Out.Write($final.ToString()) }
} catch {
    Write-Error $_
} finally {
    Remove-Item -LiteralPath $promptPath -Force -ErrorAction SilentlyContinue
}

exit $exitCode
