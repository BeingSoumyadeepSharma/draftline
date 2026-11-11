/**
 * Tests for the OpenAI-compatible client, using a fake fetch instead of a
 * real provider.
 */
import { describe, expect, it, vi } from "vitest";
import { EMPTY_PROFILE } from "@draftline/shared";
import { parseResumeCompatible } from "./openai-compatible.js";
import type { AiConfig } from "./store.js";

const config: AiConfig = {
  provider: "openai_compatible",
  baseUrl: "https://api.example.com/v1",
  model: "some-model",
  apiKey: "secret-key",
};

const extraction = {
  contact: { ...EMPTY_PROFILE.contact, fullName: "Test Person" },
  summary: "",
  experience: [],
  education: [],
  projects: [],
  certifications: [],
  skills: ["TypeScript"],
};

const reply = (content: string, finish_reason = "stop") =>
  new Response(
    JSON.stringify({ choices: [{ finish_reason, message: { content } }] }),
    { status: 200 },
  );

const resumeText = "Test Person. Software engineer with many years of experience.";
const run = (fetchFn: typeof fetch, text = resumeText, cfg = config) =>
  parseResumeCompatible(Buffer.from("%PDF"), cfg, {
    fetchFn,
    readPdfText: async () => text,
  });

const bodyOf = (fetchFn: ReturnType<typeof vi.fn>, call: number) =>
  JSON.parse(fetchFn.mock.calls[call]![1].body as string);

describe("parseResumeCompatible", () => {
  it("sends the model, key, and resume text, and returns a draft", async () => {
    const fetchFn = vi.fn(async () => reply(JSON.stringify(extraction)));
    const profile = await run(fetchFn as never);

    expect(profile.contact.fullName).toBe("Test Person");
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect(init.redirect).toBe("error");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer secret-key",
    );
    const body = bodyOf(fetchFn, 0);
    expect(body.model).toBe("some-model");
    expect(body.response_format.type).toBe("json_schema");
    expect(body.messages[1].content).toContain(resumeText);
  });

  it("omits the auth header for a keyless local model", async () => {
    const fetchFn = vi.fn(async () => reply(JSON.stringify(extraction)));
    await run(fetchFn as never, resumeText, { ...config, apiKey: "" });
    const init = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(init[1].headers).not.toHaveProperty("authorization");
  });

  it("falls back to prompting when schema output is rejected", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(reply(JSON.stringify(extraction)));

    const profile = await run(fetchFn as never);

    expect(profile.skills).toEqual(["TypeScript"]);
    const retry = bodyOf(fetchFn, 1);
    expect(retry.response_format).toBeUndefined();
    expect(retry.messages[0].content).toContain("JSON Schema");
  });

  it("accepts JSON wrapped in code fences", async () => {
    const fetchFn = vi.fn(async () =>
      reply(`Here it is:\n\`\`\`json\n${JSON.stringify(extraction)}\n\`\`\``),
    );
    const profile = await run(fetchFn as never);
    expect(profile.contact.fullName).toBe("Test Person");
  });

  it("rejects a reply that doesn't match the schema", async () => {
    const fetchFn = vi.fn(async () => reply('{"name":"Test"}'));
    await expect(run(fetchFn as never)).rejects.toMatchObject({ status: 502 });
  });

  it("explains a rejected key without revealing it", async () => {
    const fetchFn = vi.fn(async () => new Response("no", { status: 401 }));
    const error = (await run(fetchFn as never).catch((e) => e)) as Error;
    expect(error.message).toContain("API key");
    expect(error.message).not.toContain("secret-key");
  });

  it("reports a truncated reply", async () => {
    const fetchFn = vi.fn(async () => reply("{", "length"));
    await expect(run(fetchFn as never)).rejects.toMatchObject({ status: 422 });
  });

  it("stops before calling the provider when a PDF has no text", async () => {
    const fetchFn = vi.fn();
    await expect(run(fetchFn as never, " ")).rejects.toMatchObject({ status: 422 });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reports an unreachable provider", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(run(fetchFn as never)).rejects.toMatchObject({ status: 502 });
  });
});
