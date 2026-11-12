/** Tests for reaching the computer's own services from inside Docker. */
import { describe, expect, it } from "vitest";
import { reachableUrl } from "../src/local-address.js";

describe("reachableUrl", () => {
  it("sends localhost addresses to the alias when one is set", () => {
    expect(reachableUrl("http://localhost:11434/v1", "host.docker.internal")).toBe(
      "http://host.docker.internal:11434/v1",
    );
    expect(reachableUrl("http://127.0.0.1:11434/v1", "host.docker.internal")).toBe(
      "http://host.docker.internal:11434/v1",
    );
  });

  it("leaves other addresses, and everything outside Docker, unchanged", () => {
    expect(reachableUrl("https://api.openai.com/v1", "host.docker.internal")).toBe(
      "https://api.openai.com/v1",
    );
    expect(reachableUrl("http://localhost:11434/v1", "")).toBe("http://localhost:11434/v1");
    expect(reachableUrl("http://localhost:11434/v1", undefined)).toBe("http://localhost:11434/v1");
  });
});
