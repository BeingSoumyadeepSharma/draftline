/**
 * The provider-neutral AI layer. The rest of the server asks for AI work through
 * AiService and never needs to know which provider is behind it:
 *   - Claude (claude.ts), through the Anthropic SDK. The default.
 *   - Any OpenAI-compatible API (openai-compatible.ts), chosen in AI settings.
 *
 * Every call returns data already checked against a zod schema, so callers can
 * trust its shape (though not its accuracy, which jobs.ts checks).
 */
import type { z } from "zod";
import type { AiSettingsView, Profile } from "@draftline/shared";
import { claudeStructured } from "./claude.js";
import {
  compatibleStructured,
  parseResumeCompatible,
} from "./openai-compatible.js";
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

export type GenerateRequest<S extends z.ZodType> = {
  system: string;
  user: string;
  schema: S;
  /** Short identifier some providers require for structured output. */
  name: string;
  effort: "low" | "medium" | "high";
};

/** Text in, schema-checked data out, from whichever provider is chosen. */
export type Generate = <S extends z.ZodType>(
  request: GenerateRequest<S>,
) => Promise<z.infer<S>>;

export type AiService = {
  parseResume: (pdf: Buffer) => Promise<Profile>;
  generate: Generate;
};

export function createAi(store: Store): AiService {
  return {
    parseResume(pdf) {
      const config = store.getAiConfig();
      return config?.provider === "openai_compatible"
        ? parseResumeCompatible(pdf, config)
        : parseResumeWithClaude(pdf, config?.apiKey || undefined);
    },
    generate(request) {
      const config = store.getAiConfig();
      if (config?.provider === "openai_compatible") {
        return compatibleStructured(config, request);
      }
      return claudeStructured(config?.apiKey || undefined, {
        system: request.system,
        content: request.user,
        schema: request.schema,
        effort: request.effort,
      });
    },
  };
}
