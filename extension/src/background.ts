import { isAddress } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { DEFAULTS, type Settings, type WorkerCommand, type WorkerStatus } from "./shared";

// The offscreen document has no access to chrome.storage or chrome.idle, so this script owns them.
const IDLE_SECONDS = 120;

async function getSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULTS, ...(settings ?? {}) };
}

/** Identity of this browser for the coordinator. Holds no funds, payouts go to the payout address. */
async function getMachineKey(): Promise<`0x${string}`> {
  const { machineKey } = await chrome.storage.local.get("machineKey");
  if (machineKey) return machineKey;
  const key = generatePrivateKey();
  await chrome.storage.local.set({ machineKey: key });
  return key;
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: [chrome.offscreen.Reason.WORKERS],
    justification: "Runs rented WASM and WebGPU work in a sandboxed worker while the provider has sharing turned on.",
  });
}

/** A plain notification, if the owner has not switched them off. */
async function notify(id: string, title: string, message: string) {
  const settings = await getSettings();
  if (!settings.notify) return;
  chrome.notifications.create(id, { type: "basic", iconUrl: "icons/icon128.png", title, message, priority: 0 });
}

const RENT_NOTICE_GAP_MS = 30 * 60_000; // one "a renter started" notice per half hour, however many rentals

async function setStatus(status: WorkerStatus) {
  const { status: before, lastRentNotice } = await chrome.storage.local.get(["status", "lastRentNotice"]);
  await chrome.storage.local.set({ status });
  if (status.state === "rented" && before?.state !== "rented" && Date.now() - (lastRentNotice ?? 0) > RENT_NOTICE_GAP_MS) {
    await chrome.storage.local.set({ lastRentNotice: Date.now() });
    await notify("gpuhub-rented", "Your browser is being rented", "A renter started a job. You can stop sharing any time from the GPUhub icon.");
  }
}

const fmtTokens = (raw: bigint) => {
  const v = Number(raw) / 1e18;
  return v < 0.01 ? "<0.01" : v.toFixed(2);
};

/** Looks at what the owner has earned, and says so when it has grown since the last look. */
async function checkEarnings() {
  const settings = await getSettings();
  if (!settings.notify || !isAddress(settings.payout)) return;
  try {
    const res = await fetch(new URL(`/api/provider/${settings.payout}`, settings.coordinator));
    if (!res.ok) return;
    const now = BigInt((await res.json()).claimableTokens ?? "0");
    const { lastClaimable } = await chrome.storage.local.get("lastClaimable");
    await chrome.storage.local.set({ lastClaimable: now.toString() });
    // the first look only sets the baseline, so installing never announces old earnings
    if (lastClaimable === undefined) return;
    const before = BigInt(lastClaimable);
    if (now > before) {
      let symbol = "GHUB";
      try {
        const stats = await (await fetch(new URL("/api/stats", settings.coordinator))).json();
        if (typeof stats.symbol === "string") symbol = stats.symbol;
      } catch {
        // the name is only a label
      }
      await notify("gpuhub-earned", `You earned ${fmtTokens(now - before)} ${symbol}`, `${fmtTokens(now)} ${symbol} is ready to claim. Claim it on the GPUhub site with the same wallet.`);
    }
  } catch {
    // the marketplace is down; the popup already says so
  }
}

async function sync() {
  const settings = await getSettings();
  if (!settings.enabled) {
    if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
    await setStatus({ state: "off", detail: "Turn it on to rent out this browser.", sessions: 0 });
    return;
  }

  let run = true;
  let pauseReason = "";
  if (settings.onlyIdle) {
    const idle = await chrome.idle.queryState(IDLE_SECONDS);
    if (idle === "active") {
      run = false;
      pauseReason = "You're using the PC. Resumes when you step away.";
    }
  }

  await ensureOffscreen();
  const command: WorkerCommand = { type: "gpuhub-config", run, pauseReason, machineKey: await getMachineKey(), settings };
  // The document may still be loading on the first try, it asks again with "gpuhub-ready".
  await chrome.runtime.sendMessage(command).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "gpuhub-ready") void sync();
  if (msg?.type === "gpuhub-status") void setStatus(msg.status);
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings) void sync();
});

chrome.idle.setDetectionInterval(IDLE_SECONDS);
chrome.idle.onStateChanged.addListener(() => void sync());

// Restores the worker after a browser restart or if the document went away.
chrome.alarms.create("gpuhub-sync", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "gpuhub-sync") void sync();
});
chrome.runtime.onStartup.addListener(() => void sync());
chrome.runtime.onInstalled.addListener((details) => {
  // the first time only: a page that says what this is and how to start
  if (details.reason === "install") void chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
  void sync();
});

chrome.alarms.create("gpuhub-earnings", { periodInMinutes: 5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "gpuhub-earnings") void checkEarnings();
});

// A click on a notice opens the owner's page on the marketplace.
chrome.notifications.onClicked.addListener(async (id) => {
  const settings = await getSettings();
  chrome.notifications.clear(id);
  try {
    await chrome.tabs.create({ url: new URL("/provide", settings.coordinator).toString() });
  } catch {
    // an unusable marketplace address: nothing to open
  }
});
