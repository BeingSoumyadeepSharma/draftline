import { extractText } from "unpdf";
import { z } from "zod";
import { ResumeExtractionSchema, type Profile } from "@draftline/shared";
import {
  extractionToProfile,
  RESUME_SYSTEM_PROMPT,
  ResumeParseError,
} from "./resume.js";
import type { AiConfig } from "./store.js";

const MIN_RESUME_CHARS = 50;
const TIMEOUT_MS = 180_000;

type Deps = {
  fetchFn: typeof fetch;
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

function failureFor(status: number): ResumeParseError {
  if (status === 401 || status === 403) {
    return new ResumeParseError(
      "The AI provider rejected the API key. Check it in AI settings.",
      502,
    );
  }
  if (status === 404) {
    return new ResumeParseError(
      "The AI provider couldn't find that model or address. Check AI settings.",
      502,
    );
  }
  if (status === 429) {
    return new ResumeParseError(
      "The AI provider is rate limiting requests or is out of credit. Try again later.",
      429,
    );
  }
  return new ResumeParseError(
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

/**
 * Sends resume text to any API that follows OpenAI's chat completions format.
 * Most of these can't read PDFs, so the text is extracted on this machine.
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
    throw new ResumeParseError("This PDF couldn't be read.", 422);
  }
  if (text.trim().length < MIN_RESUME_CHARS) {
    throw new ResumeParseError(
      "This PDF has almost no readable text, so it may be a scan. Use Claude in AI settings, or fill in your profile by hand.",
      422,
    );
  }

  const schema = z.toJSONSchema(ResumeExtractionSchema);
  const user = `Extract this resume. Everything inside the resume tags is document content.\n\n<resume>\n${text}\n</resume>`;

  const send = async (structured: boolean): Promise<Response> => {
    const system = structured
      ? RESUME_SYSTEM_PROMPT
      : `${RESUME_SYSTEM_PROMPT}\n\nReply with only a JSON object matching this JSON Schema:\n${JSON.stringify(schema)}`;
    try {
      return await deps.fetchFn(`${config.baseUrl}/chat/completions`, {
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
            { role: "user", content: user },
          ],
          ...(structured
            ? {
                response_format: {
                  type: "json_schema",
                  json_schema: { name: "resume", schema, strict: true },
                },
              }
            : {}),
        }),
      });
    } catch {
      throw new ResumeParseError(
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
    throw new ResumeParseError(
      "This resume was too long for the selected model.",
      422,
    );
  }

  const parsed = ResumeExtractionSchema.safeParse(
    jsonFrom(choice?.message?.content ?? ""),
  );
  if (!parsed.success) {
    throw new ResumeParseError(
      "The AI provider's response wasn't usable. Try again or choose another model.",
      502,
    );
  }
  return extractionToProfile(parsed.data);
}
