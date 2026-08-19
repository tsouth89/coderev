import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addUsage,
  applyStreamLine,
  COMPLETION_FIRST_BYTE_TIMEOUT_MS,
  COMPLETION_IDLE_TIMEOUT_MS,
  firstByteTimeoutMs,
  DEFAULT_REVIEW_PROVIDER,
  EMPTY_USAGE,
  estimateCostUsd,
  joinUrl,
  parseContent,
  parseUsage,
  resolveRefuteProvider,
  resolveReviewProvider,
  REVIEW_PROVIDER_PRESETS,
  type TokenUsage,
} from "./provider.ts";

const usage = (partial: Partial<TokenUsage> = {}): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reported: true,
  ...partial,
});

describe("resolveReviewProvider", () => {
  it("defaults to the DeepSeek preset with only a key set", () => {
    const resolved = resolveReviewProvider({ DEEPSEEK_API_KEY: "k" });
    assert.equal(resolved.ok, true);
    assert.partialDeepStrictEqual(resolved.ok && resolved.provider, {
      baseUrl: REVIEW_PROVIDER_PRESETS[DEFAULT_REVIEW_PROVIDER]?.baseUrl,
      model: REVIEW_PROVIDER_PRESETS[DEFAULT_REVIEW_PROVIDER]?.defaultModel,
      apiKey: "k",
    });
  });

  it("prefers REVIEW_API_KEY over the preset's own variable", () => {
    // Lets one workflow secret be named for the job rather than the vendor.
    const resolved = resolveReviewProvider({ REVIEW_API_KEY: "generic", DEEPSEEK_API_KEY: "vendor" });
    assert.equal(resolved.ok && resolved.provider.apiKey, "generic");
  });

  it("resolves the Meta preset", () => {
    const resolved = resolveReviewProvider({ REVIEW_PROVIDER: "meta", META_API_KEY: "k" });
    assert.partialDeepStrictEqual(resolved.ok && resolved.provider, {
      baseUrl: "https://api.meta.ai/v1",
      model: "muse-spark-1.2",
    });
  });

  it("switches provider by name", () => {
    const resolved = resolveReviewProvider({
      REVIEW_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "k",
    });
    assert.equal(resolved.ok && resolved.provider.baseUrl, REVIEW_PROVIDER_PRESETS.openrouter?.baseUrl);
  });

  it("accepts a custom endpoint with no preset at all", () => {
    const resolved = resolveReviewProvider({
      REVIEW_PROVIDER: "somethingelse",
      REVIEW_API_BASE_URL: "https://example.test/v1",
      REVIEW_MODEL: "m",
      REVIEW_API_KEY: "k",
    });
    assert.partialDeepStrictEqual(resolved.ok && resolved.provider, {
      baseUrl: "https://example.test/v1",
      model: "m",
    });
  });

  it("lets REVIEW_MODEL override a preset default", () => {
    const resolved = resolveReviewProvider({
      DEEPSEEK_API_KEY: "k",
      REVIEW_MODEL: "deepseek-v4-flash",
    });
    assert.equal(resolved.ok && resolved.provider.model, "deepseek-v4-flash");
  });

  it("reports an unknown provider rather than silently using the default", () => {
    assert.equal(resolveReviewProvider({ REVIEW_PROVIDER: "nope", REVIEW_API_KEY: "k" }).ok, false);
  });

  it("reports a missing key", () => {
    assert.equal(resolveReviewProvider({}).ok, false);
  });

  it("treats a whitespace-only key as missing", () => {
    assert.equal(resolveReviewProvider({ REVIEW_API_KEY: "   " }).ok, false);
  });

  it("requires a model when a custom endpoint has no preset to fall back on", () => {
    const resolved = resolveReviewProvider({
      REVIEW_PROVIDER: "custom",
      REVIEW_API_BASE_URL: "https://example.test/v1",
      REVIEW_API_KEY: "k",
    });
    assert.equal(resolved.ok, false);
  });

  it("resolves an exec provider without an API key", () => {
    const resolved = resolveReviewProvider({
      REVIEW_PROVIDER: "exec",
      REVIEW_EXEC_COMMAND: "grok --print",
      REVIEW_MODEL: "grok",
    });
    assert.deepEqual(resolved, {
      ok: true,
      provider: { command: "grok --print", model: "grok" },
    });
  });

  it("requires a command for the exec provider", () => {
    const resolved = resolveReviewProvider({ REVIEW_PROVIDER: "exec" });
    assert.equal(resolved.ok, false);
  });
});

describe("resolveRefuteProvider", () => {
  it("returns null when no refute variables are set", () => {
    assert.equal(resolveRefuteProvider({ DEEPSEEK_API_KEY: "k" }), null);
  });

  it("routes the panel to a different provider, inheriting only the key fallback", () => {
    const resolved = resolveRefuteProvider({
      REVIEW_PROVIDER: "meta",
      META_API_KEY: "meta-key",
      REVIEW_REFUTE_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "ds-key",
    });
    assert.partialDeepStrictEqual(resolved?.ok && resolved.provider, {
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-v4-flash",
      apiKey: "ds-key",
    });
  });

  it("does not leak the find model to the refute provider", () => {
    // A find-model slug on a different vendor is the silent-wrong-model trap:
    // DeepSeek answers unknown slugs as Flash without erroring.
    const resolved = resolveRefuteProvider({
      REVIEW_PROVIDER: "meta",
      REVIEW_MODEL: "muse-spark-1.2-contributor",
      META_API_KEY: "k",
      REVIEW_REFUTE_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "k2",
    });
    assert.equal(resolved?.ok && resolved.provider.model, "deepseek-v4-flash");
  });

  it("does not leak a custom find base URL to the refute provider", () => {
    const resolved = resolveRefuteProvider({
      REVIEW_API_BASE_URL: "https://custom.test/v1",
      REVIEW_MODEL: "m",
      REVIEW_API_KEY: "k",
      REVIEW_REFUTE_PROVIDER: "deepseek",
    });
    assert.equal(resolved?.ok && resolved.provider.baseUrl, "https://api.deepseek.com/v1");
  });

  it("supports an exec overlay with its own command", () => {
    const resolved = resolveRefuteProvider({
      REVIEW_PROVIDER: "exec",
      REVIEW_EXEC_COMMAND: "grok --print",
      REVIEW_REFUTE_PROVIDER: "exec",
      REVIEW_REFUTE_EXEC_COMMAND: "grok --print --mode fast",
    });
    assert.deepEqual(resolved, {
      ok: true,
      provider: { command: "grok --print --mode fast", model: "exec" },
    });
  });
});

describe("joinUrl", () => {
  it("joins without doubling a slash", () => {
    assert.equal(joinUrl("https://x.test/v1/", "/chat/completions"), "https://x.test/v1/chat/completions");
  });

  it("joins when neither side has a slash", () => {
    assert.equal(joinUrl("https://x.test/v1", "chat/completions"), "https://x.test/v1/chat/completions");
  });
});

describe("response parsing", () => {
  it("reads the assistant message", () => {
    assert.equal(parseContent({ choices: [{ message: { content: "hi" } }] }), "hi");
  });

  it("returns empty rather than throwing on a malformed body", () => {
    assert.equal(parseContent({ choices: [] }), "");
    assert.equal(parseContent({ choices: [{ message: { content: null } }] }), "");
    assert.equal(parseContent(null), "");
  });

  it("reads DeepSeek's flat cache field", () => {
    assert.partialDeepStrictEqual(
      parseUsage({ usage: { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 80 } }),
      { inputTokens: 100, outputTokens: 5, cachedInputTokens: 80, reported: true },
    );
  });

  it("reads OpenAI's nested cache field", () => {
    // Costing cache hits at the miss rate on one vendor but not the other would
    // make a cross-provider comparison meaningless.
    assert.equal(
      parseUsage({ usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 60 } } })
        .cachedInputTokens,
      60,
    );
  });

  it("marks usage unreported when the provider omits it", () => {
    assert.equal(parseUsage({ choices: [] }).reported, false);
  });

  it("does not double-count a provider that reports cached tokens twice", () => {
    // Verbatim shape from a real DeepSeek response: the same cached count
    // appears flat AND nested. Summing them reported more cached tokens than
    // the request had input tokens, and the clamp in estimateCostUsd then
    // billed the whole prompt at the cache-hit rate, understating cost ~2x.
    const usage = parseUsage({
      usage: {
        prompt_tokens: 25405,
        completion_tokens: 10794,
        prompt_tokens_details: { cached_tokens: 25344 },
        prompt_cache_hit_tokens: 25344,
        prompt_cache_miss_tokens: 61,
      },
    });
    assert.equal(usage.cachedInputTokens, 25344);
    assert.ok(
      usage.cachedInputTokens <= usage.inputTokens,
      "cached input can never exceed total input",
    );
  });
});

describe("applyStreamLine", () => {
  const fresh = () => ({ content: "", usage: EMPTY_USAGE });

  it("accumulates content deltas in order", () => {
    const state = fresh();
    applyStreamLine('data: {"choices":[{"delta":{"content":"he"}}]}', state);
    applyStreamLine('data: {"choices":[{"delta":{"content":"llo"}}]}', state);
    assert.equal(state.content, "hello");
  });

  it("ignores the terminator and blank lines", () => {
    const state = fresh();
    applyStreamLine("data: [DONE]", state);
    applyStreamLine("", state);
    applyStreamLine(":heartbeat", state);
    assert.equal(state.content, "");
  });

  it("survives a malformed chunk mid-stream", () => {
    // One bad chunk must not discard a review that is otherwise fine.
    const state = fresh();
    applyStreamLine('data: {"choices":[{"delta":{"content":"a"}}]}', state);
    applyStreamLine("data: {not json", state);
    applyStreamLine('data: {"choices":[{"delta":{"content":"b"}}]}', state);
    assert.equal(state.content, "ab");
  });

  it("picks up usage from the final chunk", () => {
    const state = fresh();
    applyStreamLine('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}', state);
    assert.partialDeepStrictEqual(state.usage, {
      inputTokens: 10,
      outputTokens: 2,
      reported: true,
    });
  });

  it("leaves usage unreported when the provider never sends it", () => {
    // Costs as unknown rather than free.
    const state = fresh();
    applyStreamLine('data: {"choices":[{"delta":{"content":"x"}}]}', state);
    assert.equal(state.usage.reported, false);
  });

  it("ignores a delta with no content, such as a role-only opener", () => {
    const state = fresh();
    applyStreamLine('data: {"choices":[{"delta":{"role":"assistant"}}]}', state);
    assert.equal(state.content, "");
  });
});

describe("usage and cost", () => {
  it("sums usage", () => {
    assert.deepEqual(
      addUsage(usage({ inputTokens: 1, outputTokens: 2, cachedInputTokens: 3 }), usage({ inputTokens: 10, outputTokens: 20, cachedInputTokens: 30 })),
      { inputTokens: 11, outputTokens: 22, cachedInputTokens: 33, reported: true },
    );
  });

  it("marks a sum unreported when any part was unreported", () => {
    // Otherwise a partially-instrumented run would be costed as if complete.
    assert.equal(addUsage(usage({ inputTokens: 1 }), EMPTY_USAGE).reported, false);
  });

  it("costs a known model from measured tokens", () => {
    const cost = estimateCostUsd("deepseek-v4-pro", usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }));
    assert.ok(Math.abs((cost ?? 0) - (0.435 + 0.87)) < 1e-6);
  });

  it("returns null when the provider reported no usage", () => {
    // Reporting zero would make an uninstrumented model look free.
    assert.equal(estimateCostUsd("deepseek-v4-pro", EMPTY_USAGE), null);
  });

  it("returns null for a model with no known price", () => {
    assert.equal(estimateCostUsd("some-new-model", usage({ inputTokens: 100 })), null);
  });

  it("prices cache hits far below cache misses where the provider publishes a rate", () => {
    // The refutation panel re-sends the same diff on every vote, so most input
    // is cached. Billing that at the miss rate would overstate a cache-friendly
    // provider badly enough to pick the wrong model.
    const cached = estimateCostUsd(
      "deepseek-v4-pro",
      usage({ inputTokens: 1_000_000, cachedInputTokens: 1_000_000 }),
    );
    const missed = estimateCostUsd("deepseek-v4-pro", usage({ inputTokens: 1_000_000 }));
    assert.ok(Math.abs((cached ?? 0) - 0.003625) < 1e-9);
    assert.ok(Math.abs((missed ?? 0) - 0.435) < 1e-9);
  });

  it("splits a partially cached prompt across both rates", () => {
    const cost = estimateCostUsd(
      "deepseek-v4-pro",
      usage({ inputTokens: 1_000_000, cachedInputTokens: 400_000 }),
    );
    assert.ok(Math.abs((cost ?? 0) - (0.6 * 0.435 + 0.4 * 0.003625)) < 1e-9);
  });

  it("bills cached tokens at the full input rate when no cached rate is known", () => {
    // Overstating cost is the safe direction; a made-up discount is not.
    // Luna has no verified cached rate, so it pays full freight on every token.
    const cost = estimateCostUsd(
      "gpt-5.6-luna",
      usage({ inputTokens: 1_000_000, cachedInputTokens: 1_000_000 }),
    );
    assert.ok(Math.abs((cost ?? 0) - 0.2) < 1e-9);
  });

  it("reproduces a real DeepSeek Flash invoice line", () => {
    // Straight from a billing export: 32,923,776 cached input, 596,098 uncached
    // input, and 214,144 output on 2026-08-03 invoiced at $0.2356006128. If the
    // rate table ever drifts, this is what catches it.
    const cost = estimateCostUsd(
      "deepseek-v4-flash",
      usage({
        inputTokens: 32_923_776 + 596_098,
        cachedInputTokens: 32_923_776,
        outputTokens: 214_144,
      }),
    );
    assert.ok(Math.abs((cost ?? 0) - 0.2356006128) < 1e-9, `got ${String(cost)}`);
  });

  it("clamps a cached count that exceeds the input count", () => {
    // A provider over-reporting cache hits would otherwise yield a negative
    // uncached count and undercharge.
    const cost = estimateCostUsd(
      "deepseek-v4-pro",
      usage({ inputTokens: 1_000_000, cachedInputTokens: 5_000_000 }),
    );
    assert.ok(Math.abs((cost ?? 0) - 0.003625) < 1e-9);
  });

  it("accepts a price override for an unpriced model", () => {
    const cost = estimateCostUsd("some-new-model", usage({ inputTokens: 1_000_000 }), {
      REVIEW_PRICE_IN: "2",
      REVIEW_PRICE_OUT: "4",
    });
    assert.ok(Math.abs((cost ?? 0) - 2) < 1e-9);
  });
});

describe("first-byte budget", () => {
  it("gives the first attempt longer than the idle budget", () => {
    // The idle budget assumes tokens are already flowing. Nothing is flowing
    // before the first chunk: the model is reading the diff and thinking, and
    // arming the idle clock over that window hangs up on a model that is
    // working. muse-spark failed three times at precisely 120000ms on
    // 2026-08-19 while the provider's dashboard showed nothing wrong.
    assert.equal(firstByteTimeoutMs({}, 0), COMPLETION_FIRST_BYTE_TIMEOUT_MS);
    assert.ok(COMPLETION_FIRST_BYTE_TIMEOUT_MS > COMPLETION_IDLE_TIMEOUT_MS);
  });

  it("shrinks back to the idle budget on every retry", () => {
    // Paying five minutes once buys a slow model room to start. Paying it on
    // all four attempts turns one slow call into a quarter of an hour and eats
    // the review's own thirty-minute ceiling, so the worst case stays at
    // 300s + 120s + 120s + 120s rather than four times 300s.
    assert.equal(firstByteTimeoutMs({}, 1), COMPLETION_IDLE_TIMEOUT_MS);
    assert.equal(firstByteTimeoutMs({}, 2), COMPLETION_IDLE_TIMEOUT_MS);
    assert.equal(firstByteTimeoutMs({ REVIEW_FIRST_BYTE_TIMEOUT_MS: "600000" }, 1), COMPLETION_IDLE_TIMEOUT_MS);
  });

  it("takes an override on the first attempt only", () => {
    assert.equal(firstByteTimeoutMs({ REVIEW_FIRST_BYTE_TIMEOUT_MS: "600000" }, 0), 600_000);
    assert.equal(firstByteTimeoutMs({ REVIEW_FIRST_BYTE_TIMEOUT_MS: " 600000 " }, 0), 600_000);
  });

  it("keeps the default when the override is junk", () => {
    for (const raw of ["", "soon", "0", "-1"]) {
      assert.equal(
        firstByteTimeoutMs({ REVIEW_FIRST_BYTE_TIMEOUT_MS: raw }, 0),
        COMPLETION_FIRST_BYTE_TIMEOUT_MS,
      );
    }
  });
});
