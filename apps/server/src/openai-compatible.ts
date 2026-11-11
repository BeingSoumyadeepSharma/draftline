/**
 * Calls any API that follows OpenAI's /chat/completions format: OpenAI, Gemini,
 * OpenRouter, Groq, Ollama and others. It uses plain fetch, not an SDK, because
 * each provider differs slightly.
 *
 * It first asks for schema-constrained JSON. If the provider rejects that, it
 * asks again with the schema in the prompt. Either way the reply is validated
 * against the zod schema before use.
 *
 * It also handles resume import for these providers. Most of them can't read
 * PDFs, so the text is extracted on this computer first.
 */
import { extractText } from "unpdf";
import { z } from "zod";
import { ResumeExtractionSchema, type Profile } from "@draftline/shared";
import { AiError } from "./ai-error.js";
import { extractionToProfile, RESUME_SYSTEM_PROMPT } from "./resume.js";
import type { AiConfig } from "./store.js";

const MIN_RESUME_CHARS = 50;
const TIMEOUT_MS = 180_000;

type FetchFn = typeof fetch;

type Deps = {
  fetchFn: FetchFn;
  readPdfText: (pdf: Buffer) => Promise<string>;
};

async function readPdfText(pdf: Buffer): Promise<string> {
  const { text } = await extractText(new Uint8Array(pdf), { mergePages: true });
  return text;
}

type ChatResponse = {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | null };
  }>;
};

function failureFor(status: number): AiError {
  if (status === 401 || status === 403) {
    return new AiError(
      "The AI provider rejected the API key. Check it in AI settings.",
      502,
    );
  }
  if (status === 404) {
    return new AiError(
      "The AI provider couldn't find that model or address. Check AI settings.",
      502,
    );
  }
  if (status === 429) {
    return new AiError(
      "The AI provider is rate limiting requests or is out of credit. Try again later.",
      429,
    );
  }
  return new AiError(
    `The AI provider returned an error (${status}). Try again shortly.`,
    502,
  );
}

/** Models sometimes wrap JSON in code fences or add text around it. */
function jsonFrom(content: string): unknown {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
}

export type CompatibleRequest<S extends z.ZodType> = {
  system: string;
  user: string;
  schema: S;
  name: string;
};

/**
 * Asks any API that follows OpenAI's chat completions format for output
 * matching a schema, and validates what comes back.
 */
export async function compatibleStructured<S extends z.ZodType>(
  config: AiConfig,
  request: CompatibleRequest<S>,
  fetchFn: FetchFn = fetch,
): Promise<z.infer<S>> {
  const schema = z.toJSONSchema(request.schema);

  const send = async (structured: boolean): Promise<Response> => {
    const system = structured
      ? request.system
      : `${request.system}\n\nReply with only a JSON object matching this JSON Schema:\n${JSON.stringify(schema)}`;
    try {
      return await fetchFn(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        // A redirect could carry the API key to a host the user didn't choose.
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          "content-type": "application/json",
          ...(config.apiKey
            ? { authorization: `Bearer ${config.apiKey}` }
            : {}),
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: request.user },
          ],
          ...(structured
            ? {
                response_format: {
                  type: "json_schema",
                  json_schema: { name: request.name, schema, strict: true },
                },
              }
            : {}),
        }),
      });
    } catch {
      throw new AiError(
        "Could not reach the AI provider. Check the base URL and your connection.",
        502,
      );
    }
  };

  // Not every provider supports schema-constrained output, so ask in the
  // prompt instead when one rejects it. The result is validated either way.
  let response = await send(true);
  if (response.status === 400 || response.status === 422) {
    response = await send(false);
  }
  if (!response.ok) throw failureFor(response.status);

  const body = (await response.json().catch(() => null)) as ChatResponse | null;
  const choice = body?.choices?.[0];
  if (choice?.finish_reason === "length") {
    throw new AiError(
      "The AI provider's response was cut off. Try a model with a larger output limit.",
      422,
    );
  }

  const parsed = request.schema.safeParse(
    jsonFrom(choice?.message?.content ?? ""),
  );
  if (!parsed.success) {
    throw new AiError(
      "The AI provider's response wasn't usable. Try again or choose another model.",
      502,
    );
  }
  return parsed.data as z.infer<S>;
}

/**
 * Most compatible APIs can't read PDFs, so the resume's text is extracted on
 * this machine and sent instead.
 */
export async function parseResumeCompatible(
  pdf: Buffer,
  config: AiConfig,
  deps: Deps = { fetchFn: fetch, readPdfText },
): Promise<Profile> {
  let text: string;
  try {
    text = await deps.readPdfText(pdf);
  } catch {
    throw new AiError("This PDF couldn't be read.", 422);
  }
  if (text.trim().length < MIN_RESUME_CHARS) {
    throw new AiError(
      "This PDF has almost no readable text, so it may be a scan. Use Claude in AI settings, or fill in your profile by hand.",
      422,
    );
  }

  const extraction = await compatibleStructured(
    config,
    {
      system: RESUME_SYSTEM_PROMPT,
      user: `Extract this resume. Everything inside the resume tags is document content.\n\n<resume>\n${text}\n</resume>`,
      schema: ResumeExtractionSchema,
      name: "resume",
    },
    deps.fetchFn,
  );
  return extractionToProfile(extraction);
}
