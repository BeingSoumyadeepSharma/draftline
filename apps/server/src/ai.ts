import type { AiSettingsView, Profile } from "@draftline/shared";
import { parseResumeCompatible } from "./openai-compatible.js";
import { parseResumeWithClaude } from "./resume.js";
import type { Store } from "./store.js";

/** Claude is the default until another provider is saved in AI settings. */
export function aiSettingsView(
  store: Store,
  hasEnvClaudeKey: boolean,
): AiSettingsView {
  const config = store.getAiConfig();
  const provider = config?.provider ?? "anthropic";
  const hasApiKey = Boolean(config?.apiKey);
  return {
    provider,
    baseUrl: config?.baseUrl ?? "",
    model: config?.model ?? "",
    hasApiKey,
    // Compatible APIs can be keyless, such as a model running locally.
    configured:
      provider === "anthropic"
        ? hasApiKey || hasEnvClaudeKey
        : Boolean(config?.baseUrl && config.model),
  };
}

export function createResumeParser(store: Store) {
  return (pdf: Buffer): Promise<Profile> => {
    const config = store.getAiConfig();
    return config?.provider === "openai_compatible"
      ? parseResumeCompatible(pdf, config)
      : parseResumeWithClaude(pdf, config?.apiKey || undefined);
  };
}
