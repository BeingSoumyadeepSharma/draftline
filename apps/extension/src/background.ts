/**
 * Service worker. It:
 *   - opens the side panel when the toolbar icon is clicked
 *   - records submissions the content script noticed (see submission.ts)
 *   - shows the number of follow-ups due as a badge on the toolbar icon
 *   - shows a desktop notification when job discovery finds new matching
 *     jobs, checking the local server every minute
 */
import type { AlertsResponse } from "@draftline/shared";
import { notificationFor } from "./alerts";
import type { AppliedMessage } from "./submission";

const API = "http://127.0.0.1:8787/api";
/** Where the time of the last alert check is kept between restarts. */
const SINCE_KEY = "alertsSince";
/** Notification id → address to open when it's clicked. */
const TARGETS_KEY = "notificationTargets";

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

/** Shows the due follow-ups count, or nothing when there are none or the app is off. */
async function refreshBadge(): Promise<void> {
  try {
    const response = await fetch(`${API}/tracker/due`);
    const { count } = (await response.json()) as { count: number };
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
    await chrome.action.setBadgeBackgroundColor({ color: "#a93a2c" });
    await chrome.action.setTitle({
      title: count > 0 ? `Open Draftline (${count} follow-ups due)` : "Open Draftline",
    });
  } catch {
    // Draftline isn't running; leave the icon plain.
    await chrome.action.setBadgeText({ text: "" });
  }
}

/**
 * Asks the server for jobs that appeared since the last check and shows one
 * notification for them. The very first check only records the time, so
 * installing the extension doesn't announce jobs found earlier.
 */
async function checkForNewJobs(): Promise<void> {
  const stored = (await chrome.storage.local.get(SINCE_KEY))[SINCE_KEY] as string | undefined;
  let answer: AlertsResponse;
  try {
    const response = await fetch(
      `${API}/discovery/alerts?since=${encodeURIComponent(stored ?? new Date().toISOString())}`,
    );
    answer = (await response.json()) as AlertsResponse;
  } catch {
    return; // Draftline isn't running; try again next minute.
  }
  await chrome.storage.local.set({ [SINCE_KEY]: answer.now });
  if (!stored) return;

  const content = notificationFor(answer.jobs);
  if (!content) return;
  const id = `jobs-${answer.now}`;
  const targets = ((await chrome.storage.local.get(TARGETS_KEY))[TARGETS_KEY] ?? {}) as Record<string, string>;
  await chrome.storage.local.set({ [TARGETS_KEY]: { ...targets, [id]: content.url } });
  chrome.notifications.create(id, {
    type: "basic",
    iconUrl: "icons/icon-128.png",
    title: content.title,
    message: content.message,
    priority: 2,
  });
}

chrome.notifications.onClicked.addListener(async (id) => {
  const targets = ((await chrome.storage.local.get(TARGETS_KEY))[TARGETS_KEY] ?? {}) as Record<string, string>;
  const url = targets[id];
  if (url) await chrome.tabs.create({ url });
  delete targets[id];
  await chrome.storage.local.set({ [TARGETS_KEY]: targets });
  chrome.notifications.clear(id);
});

function scheduleAlarms(): void {
  void chrome.alarms.create("follow-ups", { periodInMinutes: 60 });
  void chrome.alarms.create("new-jobs", { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(() => {
  scheduleAlarms();
  void refreshBadge();
  void checkForNewJobs();
});
chrome.runtime.onStartup.addListener(() => {
  scheduleAlarms();
  void refreshBadge();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "follow-ups") void refreshBadge();
  if (alarm.name === "new-jobs") void checkForNewJobs();
});

chrome.runtime.onMessage.addListener((message: { type?: string }) => {
  if (message.type === "refresh-badge") void refreshBadge();
  if (message.type === "applied") {
    const { url, title, company } = message as AppliedMessage;
    void fetch(`${API}/jobs/applied`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, title, company, source: "detected" }),
    })
      .catch(() => {})
      .finally(() => void refreshBadge());
  }
  return false;
});
