import { AnthropicLlm } from "./anthropic.js";
import { OpenAICompatibleLlm } from "./openai.js";
import { LlmError, type LlmClient, type LlmRequest, type ModelResponse } from "./types.js";

export type ProviderKind =
  | "anthropic"
  | "openai"
  | "azure_openai"
  | "google_gemini"
  | "mistral"
  | "groq"
  | "together"
  | "openrouter"
  | "deepseek"
  | "xai"
  | "ollama"
  | "vllm"
  | "lmstudio"
  | "openai_compatible";

export interface ProviderPreset {
  id: ProviderKind;
  name: string;
  /** closed: hosted proprietary models; open: open-weight models (hosted or self-hosted). */
  license: "closed" | "open" | "both";
  /** Default base URL; empty means the user must supply one. */
  baseUrl: string;
  needsKey: boolean;
  exampleModels: string[];
  notes: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "anthropic",
    name: "Anthropic (Claude)",
    license: "closed",
    baseUrl: "https://api.anthropic.com",
    needsKey: false,
    exampleModels: ["claude-opus-5", "claude-fable-5-1", "claude-sonnet-5", "claude-haiku-4-5"],
    notes: "Native adapter with adaptive thinking, prompt caching and refusal fallbacks. Leave the key empty to use ANTHROPIC_API_KEY from the server environment.",
  },
  {
    id: "openai",
    name: "OpenAI",
    license: "closed",
    baseUrl: "https://api.openai.com/v1",
    needsKey: true,
    exampleModels: ["gpt-5", "gpt-5-mini", "o4-mini"],
    notes: "Newer OpenAI models expect max_completion_tokens; set Token parameter accordingly.",
  },
  {
    id: "azure_openai",
    name: "Azure OpenAI",
    license: "closed",
    baseUrl: "",
    needsKey: true,
    exampleModels: ["your-deployment-name"],
    notes: "Base URL is your resource endpoint (https://NAME.openai.azure.com); the model is your deployment name. Uses the api-key header.",
  },
  {
    id: "google_gemini",
    name: "Google Gemini",
    license: "closed",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    needsKey: true,
    exampleModels: ["gemini-2.5-pro", "gemini-2.5-flash"],
    notes: "Uses Gemini's OpenAI-compatible endpoint.",
  },
  {
    id: "mistral",
    name: "Mistral",
    license: "both",
    baseUrl: "https://api.mistral.ai/v1",
    needsKey: true,
    exampleModels: ["mistral-large-latest", "mistral-medium-latest"],
    notes: "",
  },
  {
    id: "groq",
    name: "Groq",
    license: "open",
    baseUrl: "https://api.groq.com/openai/v1",
    needsKey: true,
    exampleModels: ["llama-3.3-70b-versatile", "qwen/qwen3-32b"],
    notes: "Fast hosted open-weight models.",
  },
  {
    id: "together",
    name: "Together AI",
    license: "open",
    baseUrl: "https://api.together.xyz/v1",
    needsKey: true,
    exampleModels: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "Qwen/Qwen2.5-72B-Instruct-Turbo"],
    notes: "Hosted open-weight models.",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    license: "both",
    baseUrl: "https://openrouter.ai/api/v1",
    needsKey: true,
    exampleModels: ["anthropic/claude-opus-5", "openai/gpt-5", "meta-llama/llama-3.3-70b-instruct"],
    notes: "One key for many providers' models.",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    license: "open",
    baseUrl: "https://api.deepseek.com/v1",
    needsKey: true,
    exampleModels: ["deepseek-chat"],
    notes: "",
  },
  {
    id: "xai",
    name: "xAI (Grok)",
    license: "closed",
    baseUrl: "https://api.x.ai/v1",
    needsKey: true,
    exampleModels: ["grok-4"],
    notes: "",
  },
  {
    id: "ollama",
    name: "Ollama (self-hosted)",
    license: "open",
    baseUrl: "http://localhost:11434/v1",
    needsKey: false,
    exampleModels: ["qwen3:32b", "llama3.3:70b", "mistral-small3.2"],
    notes: "Runs open models on your own hardware. Pick a model with tool-calling support.",
  },
  {
    id: "vllm",
    name: "vLLM (self-hosted)",
    license: "open",
    baseUrl: "http://localhost:8000/v1",
    needsKey: false,
    exampleModels: ["Qwen/Qwen2.5-72B-Instruct"],
    notes: "Start vLLM with --enable-auto-tool-choice and a matching --tool-call-parser.",
  },
  {
    id: "lmstudio",
    name: "LM Studio (self-hosted)",
    license: "open",
    baseUrl: "http://localhost:1234/v1",
    needsKey: false,
    exampleModels: ["qwen2.5-7b-instruct"],
    notes: "",
  },
  {
    id: "openai_compatible",
    name: "Other OpenAI-compatible endpoint",
    license: "both",
    baseUrl: "",
    needsKey: false,
    exampleModels: [],
    notes: "Any server that speaks /chat/completions with function calling, e.g. a LiteLLM gateway (which can front Bedrock, Vertex and others).",
  },
];

export const presetFor = (id: string) => PROVIDER_PRESETS.find((p) => p.id === id);

const VISION_BY_DEFAULT = new Set<ProviderKind>(["anthropic", "openai", "azure_openai", "google_gemini"]);

/** Whether a profile's model gets images: its own setting, else on for the big hosted providers. */
export const supportsVision = (profile: Pick<ModelProfile, "provider" | "options">) => profile.options?.vision ?? VISION_BY_DEFAULT.has(profile.provider);

export interface ModelOptions {
  maxTokens?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  refusalFallbacks?: boolean;
  temperature?: number;
  tokenParam?: "max_tokens" | "max_completion_tokens";
  reasoningEffort?: string;
  apiVersion?: string;
  extraHeaders?: Record<string, string>;
  /** Whether the model reads images (screenshots). Unset: on for Anthropic, OpenAI, Azure OpenAI and Gemini. */
  vision?: boolean;
  /** Your price per million input tokens (USD), for usage and cost reporting. Not sent to the provider. */
  inputUsdPerMTok?: number;
  /** Your price per million output tokens (USD). */
  outputUsdPerMTok?: number;
}

export interface ModelProfile {
  id: string;
  name: string;
  provider: ProviderKind;
  model: string;
  base_url: string;
  options: ModelOptions;
  fallback_id: string | null;
  is_default: boolean;
  has_key: boolean;
  created_at: string;
}

/** Builds a client for one profile. `apiKey` is the decrypted key (may be empty). */
export function buildLlm(profile: ModelProfile, apiKey: string, fetchImpl: typeof fetch = fetch): LlmClient {
  const o = profile.options ?? {};
  if (profile.provider === "anthropic") {
    const baseUrl = profile.base_url && profile.base_url !== presetFor("anthropic")!.baseUrl ? profile.base_url : undefined;
    return new AnthropicLlm({
      model: profile.model,
      apiKey: apiKey || undefined,
      baseUrl,
      effort: o.effort,
      maxTokens: o.maxTokens,
      // Server-side fallbacks only exist on the first-party Claude API.
      fallbacks: (o.refusalFallbacks ?? true) && !baseUrl,
      vision: supportsVision(profile),
    });
  }
  const base = (profile.base_url || presetFor(profile.provider)?.baseUrl || "").replace(/\/+$/, "");
  if (!base) throw new LlmError(`${profile.name}: no base URL configured.`, false);
  const endpoint =
    profile.provider === "azure_openai"
      ? `${base}/openai/deployments/${encodeURIComponent(profile.model)}/chat/completions?api-version=${encodeURIComponent(o.apiVersion ?? "2024-10-21")}`
      : `${base}/chat/completions`;
  return new OpenAICompatibleLlm(
    {
      provider: profile.provider,
      model: profile.model,
      endpoint,
      apiKey: apiKey || undefined,
      authHeader: profile.provider === "azure_openai" ? "api-key" : "bearer",
      maxTokens: o.maxTokens,
      tokenParam: o.tokenParam,
      temperature: o.temperature,
      reasoningEffort: o.reasoningEffort,
      extraHeaders: o.extraHeaders,
      vision: supportsVision(profile),
    },
    fetchImpl,
  );
}

/**
 * Tries each model in order. Moves on for errors a different model could fix (outages, rate limits,
 * auth or bad-request errors specific to that provider); the conversation is provider-neutral, so the
 * next model picks up where the last left off.
 */
export class FallbackLlm implements LlmClient {
  readonly label: string;

  constructor(private readonly chain: LlmClient[]) {
    if (!chain.length) throw new Error("FallbackLlm needs at least one model");
    this.label = chain.map((c) => c.label).join(" → ");
  }

  async create(request: LlmRequest): Promise<ModelResponse> {
    const errors: string[] = [];
    for (const client of this.chain) {
      try {
        return await client.create(request);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    throw new LlmError(errors.length > 1 ? `All models failed: ${errors.join(" | ")}` : errors[0], false);
  }
}
