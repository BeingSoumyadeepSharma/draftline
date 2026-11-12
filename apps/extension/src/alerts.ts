/**
 * Turns new matching jobs into one desktop notification. Used by the service
 * worker (background.ts), which asks the local server for jobs that appeared
 * since its last check.
 */
import type { JobAlert } from "@draftline/shared";

export const WEB_APP = "http://127.0.0.1:5173";

export type NotificationContent = {
  title: string;
  message: string;
  /** Opened when the notification is clicked. */
  url: string;
};

const where = (job: JobAlert) => [job.company, job.location].filter(Boolean).join(" · ");

/**
 * One job: its title, opening the posting itself so the user can apply.
 * Several: a count and the first few titles, opening the Discover tab.
 */
export function notificationFor(jobs: JobAlert[]): NotificationContent | null {
  if (jobs.length === 0) return null;
  if (jobs.length === 1) {
    const [job] = jobs;
    return { title: `New job: ${job!.title}`, message: where(job!), url: job!.url };
  }
  const shown = jobs.slice(0, 3).map((job) => `${job.title} (${job.company})`);
  const more = jobs.length > 3 ? `\nand ${jobs.length - 3} more` : "";
  return {
    title: `${jobs.length} new matching jobs`,
    message: shown.join("\n") + more,
    url: `${WEB_APP}/#/discover`,
  };
}
