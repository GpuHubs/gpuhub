export interface Settings {
  enabled: boolean;
  payout: string;
  coordinator: string;
  hourlyUsd: number;
  onlyIdle: boolean;
  onlyPlugged: boolean;
  /** Tell the owner when a renter starts and when earnings arrive. */
  notify: boolean;
}

export const DEFAULTS: Settings = {
  enabled: false, // sharing a PC is always opt-in
  payout: "",
  coordinator: "https://gpuhub.app",
  hourlyUsd: 0.02,
  onlyIdle: true,
  onlyPlugged: true,
  notify: true,
};

export interface WorkerStatus {
  state: "off" | "paused" | "connecting" | "online" | "rented" | "error";
  detail: string;
  sessions: number;
}

/** Sent from the service worker to the offscreen document. */
export interface WorkerCommand {
  type: "gpuhub-config";
  run: boolean;
  pauseReason: string;
  machineKey: `0x${string}`;
  settings: Settings;
}

/** Same rule for the popup and the worker: only web URLs. */
export function coordinatorSocketUrl(http: string): string | null {
  try {
    const u = new URL(http);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    // Plain http only for this machine. Rented work must not cross the network unencrypted.
    if (u.protocol === "http:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") return null;
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = "/machine";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}
