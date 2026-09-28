import type { Store } from "../store.js";
import { buildLlm, FallbackLlm, presetFor, type ModelProfile } from "./providers.js";
import type { LlmClient } from "./types.js";

export interface ModelBootstrap {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  fallbacks: boolean;
}

const MAX_CHAIN = 4;

/** Resolves which model (and fallback chain) serves each client, with keys decrypted only here. */
export class ModelRegistry {
  private readonly cache = new Map<string, LlmClient>();

  constructor(
    private readonly store: Store,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** First start: a Claude profile that uses the server's environment credentials. */
  ensureDefault(bootstrap: ModelBootstrap): void {
    if (this.store.listModelProfiles().length) return;
    this.store.createModelProfile({
      name: "Claude (server environment)",
      provider: "anthropic",
      model: bootstrap.model,
      options: { effort: bootstrap.effort, refusalFallbacks: bootstrap.fallbacks },
      isDefault: true,
    });
  }

  invalidate(): void {
    this.cache.clear();
  }

  profileFor(orgId: string | null): ModelProfile | null {
    const org = orgId ? this.store.getOrg(orgId) : null;
    const chosen = org?.settings.modelProfileId ? this.store.getModelProfile(org.settings.modelProfileId) : null;
    return chosen ?? this.store.getDefaultModelProfile();
  }

  /** The profile followed by its fallbacks, without cycles. */
  chain(profile: ModelProfile): ModelProfile[] {
    const chain: ModelProfile[] = [];
    let current: ModelProfile | null = profile;
    while (current && chain.length < MAX_CHAIN && !chain.some((p) => p.id === current!.id)) {
      chain.push(current);
      current = current.fallback_id ? this.store.getModelProfile(current.fallback_id) : null;
    }
    return chain;
  }

  clientForProfile(profile: ModelProfile, withFallbacks = true): LlmClient {
    const chain = withFallbacks ? this.chain(profile) : [profile];
    const cacheKey = chain.map((p) => p.id).join(">");
    let client = this.cache.get(cacheKey);
    if (!client) {
      const clients = chain.map((p) => buildLlm(p, this.store.getModelApiKey(p.id), this.fetchImpl));
      client = clients.length === 1 ? clients[0] : new FallbackLlm(clients);
      this.cache.set(cacheKey, client);
    }
    return client;
  }

  clientFor(orgId: string | null): LlmClient {
    const profile = this.profileFor(orgId);
    if (!profile) throw new Error("No AI model is configured. Add one on the AI models page.");
    return this.clientForProfile(profile);
  }

  /** Whether the default model plausibly has credentials (for the dashboard banner). */
  defaultConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
    const profile = this.store.getDefaultModelProfile();
    if (!profile) return false;
    if (profile.has_key) return true;
    if (profile.provider === "anthropic") return Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE);
    return !presetFor(profile.provider)?.needsKey;
  }
}
