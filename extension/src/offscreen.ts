import { isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { coordinatorSocketUrl, type Settings, type WorkerCommand, type WorkerStatus } from "./shared";

let command: WorkerCommand | null = null;
let ws: WebSocket | null = null;
let socketKey = "";
let sessions = 0;
let current: string | null = null;
let retryMs = 1_000;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let battery: any = null;
const running = new Set<Worker>();

const report = (state: WorkerStatus["state"], detail: string) => {
  const status: WorkerStatus = { state, detail, sessions };
  chrome.runtime.sendMessage({ type: "gpuhub-status", status }).catch(() => {});
};

/** What the browser can honestly say about this PC. Browsers hide exact GPU models and memory. */
async function detectSpecs() {
  let gpu: { name: string; vramGb: number } | null = null;
  try {
    const adapter = await (navigator as any).gpu?.requestAdapter({ powerPreference: "high-performance" });
    if (adapter) {
      const info = adapter.info ?? {};
      const name = [info.vendor, info.architecture].filter(Boolean).join(" ") || "WebGPU device";
      // A browser does not tell the amount of video memory, so none is claimed.
      gpu = { name, vramGb: 0 };
    }
  } catch {
    gpu = null;
  }
  return {
    cpuCores: navigator.hardwareConcurrency || 1,
    ramGb: (navigator as any).deviceMemory ?? 0,
    gpu,
    os: "browser",
  };
}

async function hashChain(nonce: string, iters: number): Promise<string> {
  let h: ArrayBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce));
  for (let i = 1; i < iters; i++) h = await crypto.subtle.digest("SHA-256", h);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A Worker per run: a stuck or hostile module is killed by terminating it. */
function runInSandbox(request: object, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(chrome.runtime.getURL("sandbox.js"), { type: "module" });
    running.add(worker);
    const finish = () => {
      clearTimeout(timer);
      worker.terminate();
      running.delete(worker);
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error(`stopped after the ${Math.round(timeoutMs / 1000)} second limit`));
    }, timeoutMs);
    worker.onmessage = (e) => {
      finish();
      if (e.data.ok) resolve(e.data.result);
      else reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      finish();
      reject(new Error(e.message || "the sandbox failed"));
    };
    worker.postMessage(request);
  });
}

function stopAllWork() {
  for (const w of running) w.terminate();
  running.clear();
  current = null;
}

function closeSocket() {
  clearTimeout(retryTimer);
  clearInterval(heartbeat);
  socketKey = "";
  const s = ws;
  ws = null;
  stopAllWork();
  if (s && s.readyState <= WebSocket.OPEN) s.close(1000, "paused");
}

function pauseReason(cmd: WorkerCommand): string {
  if (!cmd.run) return cmd.pauseReason;
  if (cmd.settings.onlyPlugged && battery && !battery.charging) return "On battery. Resumes when plugged in.";
  // The same check as the desktop app, which also catches a mistyped checksummed address.
  if (!isAddress(cmd.settings.payout)) return "Add a payout address to start.";
  if (!coordinatorSocketUrl(cmd.settings.coordinator)) return "Coordinator must be https, or http on this machine.";
  if (!(cmd.settings.hourlyUsd > 0)) return "Set a price per hour to start.";
  return "";
}

function apply() {
  const cmd = command;
  if (!cmd) return;
  const reason = pauseReason(cmd);
  if (reason) {
    closeSocket();
    report("paused", reason);
    return;
  }
  const s = cmd.settings;
  const key = `${s.coordinator}|${s.payout}|${s.hourlyUsd}|${cmd.machineKey}`;
  if (socketKey === key && ws) return;
  closeSocket();
  socketKey = key;
  void connect(s, cmd.machineKey, key);
}

function scheduleRetry(key: string) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    if (socketKey === key && command) void connect(command.settings, command.machineKey, key);
  }, retryMs);
  retryMs = Math.min(retryMs * 2, 60_000);
}

async function connect(settings: Settings, machineKey: `0x${string}`, key: string) {
  const account = privateKeyToAccount(machineKey);
  const specs = await detectSpecs();
  if (socketKey !== key) return;
  const socket = new WebSocket(coordinatorSocketUrl(settings.coordinator)!);
  ws = socket;
  report("connecting", "Connecting to the marketplace…");
  const send = (m: unknown) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(m));
  };

  socket.onmessage = async (event) => {
    const m = JSON.parse(event.data);
    switch (m.type) {
      case "challenge": {
        const signature = await account.signMessage({ message: `gpuhub-machine:${m.challenge}:${settings.payout.toLowerCase()}` });
        send({
          type: "hello",
          key: account.address,
          payout: settings.payout,
          kind: "browser",
          specs,
          hourlyUnits: String(Math.round(settings.hourlyUsd * 1e6)),
          signature,
        });
        break;
      }
      case "benchmark":
        report("connecting", "Measuring this PC…");
        send({ type: "benchmark.result", hash: await hashChain(m.nonce, m.iters) });
        break;
      case "welcome":
        retryMs = 1_000;
        report("online", `Listed at $${settings.hourlyUsd} an hour, waiting for a renter.`);
        clearInterval(heartbeat);
        heartbeat = setInterval(() => send({ type: "ping" }), 10_000);
        break;
      case "rejected":
        report("error", `The marketplace refused: ${m.reason}`);
        break;
      case "session.start":
        current = m.sessionId;
        sessions++;
        report("rented", "Rented right now. Stop any time with the switch above.");
        send({ type: "reply", id: m.id, result: { ok: true } });
        break;
      case "session.exec":
        if (m.sessionId !== current) {
          send({ type: "reply", id: m.id, error: "no such session" });
          break;
        }
        // One run at a time: each is a Worker with its own memory, and parallel ones add up.
        if (running.size > 0) {
          send({ type: "reply", id: m.id, error: "another run is still going, send the next one when it ends" });
          break;
        }
        try {
          send({ type: "reply", id: m.id, result: await runInSandbox(m.request, m.timeoutMs) });
        } catch (e) {
          send({ type: "reply", id: m.id, error: e instanceof Error ? e.message : "failed" });
        }
        break;
      case "session.stop":
        stopAllWork();
        report("online", `Listed at $${settings.hourlyUsd} an hour, waiting for a renter.`);
        send({ type: "reply", id: m.id, result: { ok: true } });
        break;
    }
  };
  socket.onclose = (e) => {
    clearInterval(heartbeat);
    if (ws !== socket) return; // closed on purpose
    ws = null;
    stopAllWork();
    if (e.code === 4004 && e.reason === "banned") {
      socketKey = "";
      report("error", "This browser was banned after failed checks.");
      return;
    }
    report("connecting", "Marketplace unreachable, retrying…");
    scheduleRetry(key);
  };
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "gpuhub-config") {
    command = msg as WorkerCommand;
    apply();
  }
});

(async () => {
  try {
    battery = await (navigator as any).getBattery?.();
    battery?.addEventListener?.("chargingchange", () => apply());
  } catch {
    battery = null; // no battery API, treat as a desktop
  }
  chrome.runtime.sendMessage({ type: "gpuhub-ready" }).catch(() => {});
})();
