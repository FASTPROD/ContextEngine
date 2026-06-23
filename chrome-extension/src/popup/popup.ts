import type { CaptureStatus } from "../lib/types.js";

const $ = (id: string) => document.getElementById(id)!;
const dot = $("dot");
const state = $("state");
const queue = $("queue");
const lastSend = $("lastSend");
const errorBox = $("error");
const recentList = $("recentList");
const versionLabel = $("version");

versionLabel.textContent = `v${chrome.runtime.getManifest().version}`;

async function refresh() {
  try {
    const { ok, status } = (await chrome.runtime.sendMessage({
      type: "opscontext.status",
    })) as { ok: boolean; status: CaptureStatus | null };
    if (!ok || !status) {
      state.textContent = "unknown";
      return;
    }
    // dot class
    dot.className = `dot dot--${status.state}`;
    state.textContent = status.state;
    queue.textContent = String(status.queueLength);
    lastSend.textContent = status.lastSendAt
      ? new Date(status.lastSendAt).toLocaleTimeString()
      : "never";
    if (status.lastError) {
      errorBox.hidden = false;
      errorBox.textContent = status.lastError;
    } else {
      errorBox.hidden = true;
    }
    // recent
    recentList.innerHTML = "";
    if (status.recentEvents.length === 0) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "No events yet.";
      recentList.appendChild(li);
    } else {
      for (const ev of status.recentEvents) {
        const li = document.createElement("li");
        const kind = document.createElement("span");
        kind.className = "recent-kind";
        kind.textContent = `[${ev.kind.replace("browser.", "")}] ${ev.surface}`;
        const preview = document.createElement("span");
        preview.className = "recent-preview";
        preview.textContent = ev.preview || "(no text)";
        li.appendChild(kind);
        li.appendChild(preview);
        recentList.appendChild(li);
      }
    }
  } catch (err) {
    state.textContent = "error";
    errorBox.hidden = false;
    errorBox.textContent = err instanceof Error ? err.message : String(err);
  }
}

$("flushBtn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "opscontext.flush_now" });
  setTimeout(refresh, 500);
});

$("optionsBtn").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

refresh();
setInterval(refresh, 2_000);
