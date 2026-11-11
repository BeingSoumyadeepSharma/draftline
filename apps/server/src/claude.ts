/**
 * Calls Claude through the official Anthropic SDK.
 *
 * - Structured outputs: Claude must reply with JSON matching the zod schema,
 *   and the SDK parses it for us.
 * - Server-side fallbacks: if Claude declines a request, the API retries it on
 *   another Claude model within the same call.
 * - SDK errors are turned into AiError with a message fit to show the user.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { AiError } from "./ai-error.js";

export type ClaudeRequest<S extends z.ZodType> = {
  system: string;
  content: string | Anthropic.Beta.BetaContentBlockParam[];
  schema: S;
  effort: "low" | "medium" | "high";
};

function failureFor(error: unknown): unknown {
  if (error instanceof Anthropic.AuthenticationError) {
    return new AiError("Claude rejected the API key. Check it in AI settings.", 502);
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new AiError("Claude is rate limiting requests. Wait a minute and try again.", 429);
  }
  if (error instanceof Anthropic.BadRequestError) {
    return new AiError(`Claude couldn't process this request: ${error.message}`, 422);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new AiError("Could not reach Claude. Check your internet connection and try again.", 502);
  }
  if (error instanceof Anthropic.APIError) {
    return new AiError(`Claude returned an error (${error.status}). Try again shortly.`, 502);
  }
  return error;
}

/** Asks Claude for output matching a schema. */
export async function claudeStructured<S extends z.ZodType>(
  apiKey: string | undefined,
  request: ClaudeRequest<S>,
): Promise<z.infer<S>> {
  // With no saved key, the SDK reads ANTHROPIC_API_KEY from the environment.
  const client = new Anthropic(apiKey ? { apiKey } : {});

  let response;
  try {
    response = await client.beta.messages.parse({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: {
        effort: request.effort,
        format: betaZodOutputFormat(request.schema),
      },
      system: request.system,
      messages: [{ role: "user", content: request.content }],
    });
  } catch (error) {
    throw failureFor(error);
  }

  if (response.stop_reason === "refusal") {
    throw new AiError("Claude declined this request.", 422);
  }
  if (response.stop_reason === "max_tokens") {
    throw new AiError("Claude's response was cut off because it was too long.", 422);
  }
  if (!response.parsed_output) {
    throw new AiError("Claude's response could not be read. Try again.", 502);
  }
  return response.parsed_output as z.infer<S>;
}
