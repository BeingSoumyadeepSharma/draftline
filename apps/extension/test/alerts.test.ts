/** Tests for turning new jobs into one desktop notification. */
import { describe, expect, it } from "vitest";
import { notificationFor } from "../src/alerts";

const job = (i: number) => ({
  id: String(i),
  title: `Engineer ${i}`,
  company: "Acme",
  location: "Remote",
  url: `https://jobs.example.com/${i}`,
});

describe("notificationFor", () => {
  it("shows nothing when there are no new jobs", () => {
    expect(notificationFor([])).toBeNull();
  });

  it("opens the posting itself for a single job", () => {
    expect(notificationFor([job(1)])).toEqual({
      title: "New job: Engineer 1",
      message: "Acme · Remote",
      url: "https://jobs.example.com/1",
    });
  });

  it("summarizes several jobs and opens the Discover tab", () => {
    const content = notificationFor([job(1), job(2), job(3), job(4), job(5)])!;
    expect(content.title).toBe("5 new matching jobs");
    expect(content.message).toBe(
      "Engineer 1 (Acme)\nEngineer 2 (Acme)\nEngineer 3 (Acme)\nand 2 more",
    );
    expect(content.url).toBe("http://127.0.0.1:5173/#/discover");
  });
});
