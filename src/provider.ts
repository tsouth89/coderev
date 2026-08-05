/**
 * The model endpoint the reviewer talks to.
 *
 * Deliberately the smallest surface that still lets the provider change without
 * touching review logic: an OpenAI-compatible `POST /chat/completions` plus a
 * bearer token. DeepSeek, OpenRouter, Together, Groq, and a local llama.cpp
 * server all speak that shape, so swapping providers is environment variables
 * rather than a code change.
 *
 * Anthropic-compatible gateways want `/v1/messages` with a different body and a
 * different auth header. That is a second client, not a preset, and it is not
 * built until something needs it.
 *
 * Presets exist only to spare the caller from memorising base URLs. Every field
 * stays overridable, because a preset that cannot be overridden is just a
 * hardcoded value with extra steps.
 */

/** Long enough for a reasoning model on a large diff; short enough to fail a hung CI job. */
const COMPLETION_TIMEOUT_MS = 180_000;

export interface ReviewProviderPreset {
  readonly baseUrl: string;
  readonly defaultModel: string;
  /** Environment variable conventionally holding this provider's key. */
  readonly apiKeyEnvVar: string;
}

/**
 * Known providers, keyed by the value of `REVIEW_PROVIDER`.
 *
 * DeepSeek is the default because V4 Pro is the cheapest capable reviewer
 * available at time of writing and because it bills per token rather than
 * through a subscription. That matters more than it sounds: a
 * subscription-backed coding CLI generally cannot authenticate
 * non-interactively, which rules it out for CI regardless of its token value.
 */
export const REVIEW_PROVIDER_PRESETS: Readonly<Record<string, ReviewProviderPreset>> = {
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-v4-pro",
    apiKeyEnvVar: "DEEPSEEK_API_KEY",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "deepseek/deepseek-v4-pro",
    apiKeyEnvVar: "OPENROUTER_API_KEY",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.6-luna",
    apiKeyEnvVar: "OPENAI_API_KEY",
  },
};

export const DEFAULT_REVIEW_PROVIDER = "deepseek";

export interface ResolvedReviewProvider {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
}

/**
 * Plain data rather than a thrown error, so the resolver stays a pure function
 * and every failure mode is testable without catching.
 */
export type ReviewProviderResolution =
  | { readonly ok: true; readonly provider: ResolvedReviewProvider }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolve provider settings from the environment.
 *
 * `REVIEW_API_KEY` wins over the preset's conventional variable so a workflow
 * can hold one secret named for its job rather than one named for whichever
 * vendor it currently points at. The preset variable stays supported because it
 * is what a developer already has exported locally.
 */
export function resolveReviewProvider(
  env: Readonly<Record<string, string | undefined>>,
): ReviewProviderResolution {
  const providerName = (env.REVIEW_PROVIDER ?? DEFAULT_REVIEW_PROVIDER).trim().toLowerCase();
  const preset = REVIEW_PROVIDER_PRESETS[providerName];

  const baseUrl = env.REVIEW_API_BASE_URL?.trim() || preset?.baseUrl;
  if (!baseUrl) {
    return {
      ok: false,
      reason:
        `Unknown REVIEW_PROVIDER "${providerName}" and no REVIEW_API_BASE_URL set. ` +
        `Known providers: ${Object.keys(REVIEW_PROVIDER_PRESETS).join(", ")}.`,
    };
  }

  const model = env.REVIEW_MODEL?.trim() || preset?.defaultModel;
  if (!model) {
    return {
      ok: false,
      reason: "REVIEW_MODEL must be set when REVIEW_API_BASE_URL points at a custom provider.",
    };
  }

  const apiKey = (env.REVIEW_API_KEY ?? (preset ? env[preset.apiKeyEnvVar] : undefined))?.trim();
  if (!apiKey) {
    const named = preset ? ` or ${preset.apiKeyEnvVar}` : "";
    return { ok: false, reason: `REVIEW_API_KEY${named} is not set.` };
  }

  return { ok: true, provider: { baseUrl, model, apiKey } };
}

/** Join a base URL with a path without doubling or dropping slashes. */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Subset of `inputTokens` served from cache, where the provider reports it. */
  readonly cachedInputTokens: number;
  /** False when the provider returned no usage block at all. */
  readonly reported: boolean;
}

export const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reported: false,
};

export function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    reported: left.reported && right.reported,
  };
}

export interface ModelPrice {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
  /**
   * Rate for input served from the provider's prompt cache.
   *
   * This matters more than it looks for a review workload. The refutation panel
   * re-sends the same diff on every vote, so most input tokens after the first
   * call are cache hits, and DeepSeek prices those roughly 120x below a cache
   * miss. Charging them at the miss rate would overstate a cache-friendly
   * provider's cost badly enough to pick the wrong model.
   *
   * Omitted where no published rate was verified. Missing means cached tokens
   * bill at the full input rate, which overstates cost rather than flattering
   * it. An invented discount would be the worse error.
   */
  readonly cachedInputPerMillion?: number;
}

/**
 * Per-million-token rates, used only to turn measured tokens into a dollar
 * figure in the benchmark report.
 *
 * These rot. Vendors cut prices without notice, so treat any cost column as an
 * estimate and re-check the vendor page before making a purchasing decision on
 * it. `REVIEW_PRICE_IN`, `REVIEW_PRICE_OUT`, and `REVIEW_PRICE_CACHED_IN`
 * override an entry without editing this file.
 *
 * Verified 2026-08-05.
 */
export const MODEL_PRICING: Readonly<Record<string, ModelPrice>> = {
  "deepseek-v4-pro": {
    inputPerMillion: 0.435,
    outputPerMillion: 0.87,
    cachedInputPerMillion: 0.003625,
  },
  "deepseek-v4-flash": { inputPerMillion: 0.14, outputPerMillion: 0.28 },
  "deepseek/deepseek-v4-pro": {
    inputPerMillion: 0.435,
    outputPerMillion: 0.87,
    cachedInputPerMillion: 0.003625,
  },
  "deepseek/deepseek-v4-flash": { inputPerMillion: 0.14, outputPerMillion: 0.28 },
  "gpt-5.6-luna": { inputPerMillion: 0.2, outputPerMillion: 1.2 },
  "openai/gpt-5.6-luna": { inputPerMillion: 0.2, outputPerMillion: 1.2 },
};

/** Dollar cost for measured usage, or null when it cannot be known honestly. */
export function estimateCostUsd(
  model: string,
  usage: TokenUsage,
  env: Readonly<Record<string, string | undefined>> = {},
): number | null {
  if (!usage.reported) return null;
  const overrideIn = Number(env.REVIEW_PRICE_IN);
  const overrideOut = Number(env.REVIEW_PRICE_OUT);
  const overrideCached = Number(env.REVIEW_PRICE_CACHED_IN);
  const preset = MODEL_PRICING[model.trim().toLowerCase()];

  const inputPerMillion = Number.isFinite(overrideIn) ? overrideIn : preset?.inputPerMillion;
  const outputPerMillion = Number.isFinite(overrideOut) ? overrideOut : preset?.outputPerMillion;
  if (inputPerMillion === undefined || outputPerMillion === undefined) return null;

  // Clamped because a provider reporting more cached tokens than input tokens
  // would otherwise produce a negative uncached count and undercharge.
  const cachedTokens = Math.min(Math.max(usage.cachedInputTokens, 0), usage.inputTokens);
  const cachedPerMillion = Number.isFinite(overrideCached)
    ? overrideCached
    : (preset?.cachedInputPerMillion ?? inputPerMillion);

  return (
    ((usage.inputTokens - cachedTokens) / 1_000_000) * inputPerMillion +
    (cachedTokens / 1_000_000) * cachedPerMillion +
    (usage.outputTokens / 1_000_000) * outputPerMillion
  );
}

export interface CompletionResult {
  readonly content: string;
  readonly usage: TokenUsage;
}

export interface CompletionRequest {
  readonly provider: ResolvedReviewProvider;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  /**
   * Higher values buy independence between refutation votes. A panel of
   * skeptics sampled at temperature 0 returns the same vote N times, which
   * looks like agreement but is one opinion counted repeatedly.
   */
  readonly temperature: number;
}

/** Read usage out of a response body without trusting its shape. */
export function parseUsage(body: unknown): TokenUsage {
  if (typeof body !== "object" || body === null) return EMPTY_USAGE;
  const usage = (body as Record<string, unknown>).usage;
  if (typeof usage !== "object" || usage === null) return EMPTY_USAGE;
  const record = usage as Record<string, unknown>;
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

  // OpenAI nests its cached count; DeepSeek reports it flat. Accept both rather
  // than silently costing cache hits at the miss rate on one of them.
  const details = record.prompt_tokens_details;
  const nestedCached =
    typeof details === "object" && details !== null
      ? num((details as Record<string, unknown>).cached_tokens)
      : 0;

  return {
    inputTokens: num(record.prompt_tokens),
    outputTokens: num(record.completion_tokens),
    cachedInputTokens: num(record.prompt_cache_hit_tokens) + nestedCached,
    reported: true,
  };
}

/** Read the assistant message out of a response body without trusting its shape. */
export function parseContent(body: unknown): string {
  if (typeof body !== "object" || body === null) return "";
  const choices = (body as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const first = choices[0];
  if (typeof first !== "object" || first === null) return "";
  const message = (first as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) return "";
  const content = (message as Record<string, unknown>).content;
  return typeof content === "string" ? content : "";
}

export class ProviderRequestError extends Error {
  constructor(detail: string) {
    super(`Model request failed: ${detail}`);
    this.name = "ProviderRequestError";
  }
}

export async function requestCompletion(input: CompletionRequest): Promise<CompletionResult> {
  const response = await fetch(joinUrl(input.provider.baseUrl, "chat/completions"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.provider.apiKey}`,
    },
    body: JSON.stringify({
      model: input.provider.model,
      temperature: input.temperature,
      messages: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userPrompt },
      ],
    }),
    signal: AbortSignal.timeout(COMPLETION_TIMEOUT_MS),
  }).catch((cause: unknown) => {
    throw new ProviderRequestError(cause instanceof Error ? cause.message : String(cause));
  });

  if (!response.ok) {
    // Body often carries the actual reason (bad key, unknown model, no credit),
    // and losing it turns every failure into an opaque status code.
    const detail = await response.text().catch(() => "");
    throw new ProviderRequestError(`HTTP ${response.status} ${detail.slice(0, 300)}`);
  }

  const body: unknown = await response.json().catch((cause: unknown) => {
    throw new ProviderRequestError(`invalid JSON: ${String(cause)}`);
  });

  return { content: parseContent(body), usage: parseUsage(body) };
}
