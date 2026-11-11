/**
 * Service worker. It:
 *   - opens the side panel when the toolbar icon is clicked
 *   - records submissions the content script noticed (see submission.ts)
 *   - shows the number of follow-ups due as a badge on the toolbar icon,
 *     refreshed every hour and after anything that could change it
 */
import type { AppliedMessage } from "./submission";

const API = "http://127.0.0.1:8787/api";

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

chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create("follow-ups", { periodInMinutes: 60 });
  void refreshBadge();
});
chrome.runtime.onStartup.addListener(() => void refreshBadge());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "follow-ups") void refreshBadge();
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
