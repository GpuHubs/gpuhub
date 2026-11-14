import { isAddress } from "viem";
import { DEFAULTS, type Settings, type WorkerStatus } from "./shared";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const fields = {
  enabled: $<HTMLInputElement>("enabled"),
  payout: $<HTMLInputElement>("payout"),
  hourlyUsd: $<HTMLInputElement>("hourlyUsd"),
  coordinator: $<HTMLInputElement>("coordinator"),
  onlyIdle: $<HTMLInputElement>("onlyIdle"),
  onlyPlugged: $<HTMLInputElement>("onlyPlugged"),
  notify: $<HTMLInputElement>("notify"),
};

async function load() {
  const { settings, status } = await chrome.storage.local.get(["settings", "status"]);
  const s: Settings = { ...DEFAULTS, ...(settings ?? {}) };
  fields.enabled.checked = s.enabled;
  fields.payout.value = s.payout;
  fields.hourlyUsd.value = String(s.hourlyUsd);
  fields.coordinator.value = s.coordinator;
  fields.onlyIdle.checked = s.onlyIdle;
  fields.onlyPlugged.checked = s.onlyPlugged;
  fields.notify.checked = s.notify;
  showHint();
  if (status) showStatus(status);
  void loadEarnings(s);
}

async function save() {
  const settings: Settings = {
    enabled: fields.enabled.checked,
    payout: fields.payout.value.trim(),
    hourlyUsd: Number(fields.hourlyUsd.value) || 0,
    coordinator: fields.coordinator.value.trim() || DEFAULTS.coordinator,
    onlyIdle: fields.onlyIdle.checked,
    onlyPlugged: fields.onlyPlugged.checked,
    notify: fields.notify.checked,
  };
  await chrome.storage.local.set({ settings });
  showHint();
  void loadEarnings(settings);
}

/** One line that says what to do next: the wallet first, then the switch. */
function showHint() {
  const hint = $("hint");
  const payout = fields.payout.value.trim();
  const good = isAddress(payout);
  fields.payout.classList.toggle("need", !good);
  if (!payout) {
    hint.textContent = "Start here: add the wallet address where you want to be paid. A public address is enough, no private key.";
  } else if (!good) {
    hint.textContent = "That doesn't look like a wallet address. It starts with 0x and has 42 characters.";
  } else if (!fields.enabled.checked) {
    hint.textContent = "All set. Turn sharing on at the top when you're ready.";
  } else {
    hint.textContent = "";
  }
  hint.hidden = hint.textContent === "";
}

const LABELS: Record<WorkerStatus["state"], string> = {
  off: "Off",
  paused: "Paused",
  connecting: "Connecting",
  online: "Listed",
  rented: "Rented",
  error: "Problem",
};

function showStatus(s: WorkerStatus) {
  $("state").textContent = LABELS[s.state];
  $("detail").textContent = s.detail;
  $("sessions").textContent = String(s.sessions ?? 0);
  $("status").className = s.state === "online" || s.state === "rented" ? "good" : s.state === "error" ? "bad" : "";
}

const fmt = (raw: string, decimals: number) => {
  const v = Number(raw) / 10 ** decimals;
  return v === 0 ? "0" : v < 0.01 ? "<0.01" : v.toFixed(2);
};

async function loadEarnings(s: Settings) {
  if (!isAddress(s.payout)) return;
  try {
    const res = await fetch(new URL(`/api/provider/${s.payout}`, s.coordinator));
    if (!res.ok) return;
    const data = await res.json();
    $("spare").textContent = fmt(data.claimableTokens, 18);
    $("pending").textContent = `$${fmt(data.pendingUsdUnits, 6)}`;
  } catch {
    // The marketplace is down, the status line already says so.
  }
}

for (const el of Object.values(fields)) el.addEventListener("change", () => void save());
fields.payout.addEventListener("input", showHint);
$("help").addEventListener("click", (e) => {
  e.preventDefault();
  void chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
});
$("form").addEventListener("submit", (e) => e.preventDefault());
chrome.storage.onChanged.addListener((changes) => {
  if (changes.status?.newValue) showStatus(changes.status.newValue);
});
void load();
