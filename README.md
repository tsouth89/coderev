# CodeRev

Self-hosted pull request review. Runs a cheap model over the diff, then puts
every finding to a panel of independent skeptics and posts only what survives.

Zero runtime dependencies. Node 24, the `gh` CLI, and an API key.

## Why the panel

Cheap models generate plausible-and-wrong findings freely. A reviewer that
reports five issues per PR and is wrong on four is worse than no reviewer,
because it trains everyone to skim past the check.

So generation and judgement are separated. Findings are generated once at
temperature 0, then each one is sent to three independent skeptics prompted to
**refute** it, sampled at temperature 1 so the votes are genuinely independent.
A finding survives only if fewer than half the panel refutes it. Uncertain
votes, unparseable votes, and failed requests all count as refutations.

This is deliberately token-hungry, roughly `1 + 3N` calls per PR. That is the
point rather than a cost to be minimised: tokens are cheap, and the panel is
what buys precision. It also happens to be close to a best case for prompt
caching, since every vote re-sends the same diff.

## Usage as an action

```yaml
name: PR review
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    continue-on-error: true
    # Forks do not get secrets, so the model call would fail with a confusing
    # auth error rather than an obvious skip.
    if: github.event.pull_request.head.repo.full_name == github.repository
    steps:
      - uses: actions/checkout@v6
      - uses: tsouth89/coderev@v1
        with:
          api-key: ${{ secrets.REVIEW_API_KEY }}
          conventions: AGENTS.md
```

Start it advisory (`continue-on-error: true`). A red X on a model's opinion
trains people to ignore the whole check. Promote it to required only once its
precision has earned that.

## Usage locally

```bash
export REVIEW_API_KEY=sk-...
node bin/review-pr.ts --pr 123 --repo ../some-repo
```

Add `--post` to comment on the PR instead of printing. `--help` on either
binary lists every flag.

## Providers

Any OpenAI-compatible `/chat/completions` endpoint. Switching is environment
variables, never a code change.

| Variable | Purpose |
| --- | --- |
| `REVIEW_API_KEY` | Model key. Falls back to the provider's own variable (`DEEPSEEK_API_KEY`, etc). |
| `REVIEW_PROVIDER` | `deepseek` (default), `openrouter`, `openai`. |
| `REVIEW_MODEL` | Overrides the provider's default model. |
| `REVIEW_API_BASE_URL` | Any other compatible endpoint, including a local server. |

DeepSeek V4 Pro is the default: it is the cheapest capable reviewer at time of
writing, and it bills per token. That last part matters more than it sounds.
Subscription-backed coding CLIs generally cannot authenticate
non-interactively, which rules them out for CI whatever their token value.

Anthropic-compatible gateways (`/v1/messages`) are not supported. That is a
second client rather than a preset, and it is not built until something needs
it.

## Benchmarking

Picking a model from pricing pages does not work, because the cost that matters
depends on your diffs, your cache hit rate, and how many candidate findings the
model generates. So measure it:

```bash
node bin/review-benchmark.ts \
  --suite fixtures/toolport-studio.json \
  --repo ../toolport-studio \
  --model deepseek-v4-pro \
  --model deepseek-v4-flash \
  --limit 3
```

This runs the identical pipeline the action ships, over recorded PRs, and
reports measured cost against agreement with whatever reviewer you are
comparing to.

**Read the output carefully.** Cost is real: it comes from reported token usage,
including the cache-hit split, not from an estimate. Agreement is not.
Agreement with a baseline is agreement with whatever that baseline happened to
say, including findings its own authors ignored, which is why `actedOn` is
tracked separately. A finding that matches nothing is reported as *unmatched*,
never as a false positive, because it may be a real defect the baseline missed.

### Suite format

See [fixtures/toolport-studio.json](fixtures/toolport-studio.json). Each case is
a PR number, the baseline findings as `file`/`line`, and whether the PR received
any commit after that review landed.

## Development

```bash
npm install
npm test
npm run typecheck
```

Tests use `node:test` and cover the pure logic: parsing, the panel majority,
cost arithmetic, and baseline matching. Nothing in the test suite makes a
network call.

## License

MIT
