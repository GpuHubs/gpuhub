// The desktop app: a small server on this PC only, and its window.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { HOME, ProviderService } from "./service.ts";
import uiHtml from "./ui.html";

const FILE = join(HOME, "app.json");
const FIRST_PORT = 47823;
const args = process.argv.slice(2);

interface Running {
  port: number;
  token: string;
  /** Written by versions that know it. Lets --quit wait until the process is really gone. */
  pid?: number;
}

const readRunning = (): Running | null => {
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return null;
  }
};

/** Plain http: fetch keeps connections open, and exiting over them crashes Node on Windows. */
const call = (r: Running, path: string, method = "GET") =>
  new Promise<boolean>((resolve) => {
    const req = request({ host: "127.0.0.1", port: r.port, path, method, headers: { "x-token": r.token, connection: "close" }, timeout: 1500 }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode === 200));
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => req.destroy());
    req.end();
  });

const isAlive = async (r: Running | null) => (r ? call(r, "/health") : false);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const processExists = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Waits until the running copy has stopped its rentals and exited: it no longer answers, and its
 * process is gone, so its node.exe can be replaced. False when it is still there after the limit.
 */
async function waitUntilGone(r: Running, limitMs = 60_000) {
  const deadline = Date.now() + limitMs;
  while (await isAlive(r)) {
    if (Date.now() > deadline) return false;
    await pause(500);
  }
  while (r.pid && processExists(r.pid)) {
    if (Date.now() > deadline) return false;
    await pause(250);
  }
  return true;
}

/** Ends at once. Once fetch has been used, a normal exit can crash Node on Windows. */
const die = () => process.kill(process.pid, "SIGKILL");

/** A window with no browser bars. Edge is on every Windows 11, otherwise the default browser. */
function openWindow(url: string) {
  if (args.includes("--no-window")) return;
  const edge = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].find(existsSync);
  if (edge) spawn(edge, [`--app=${url}`, "--window-size=560,820"], { detached: true, stdio: "ignore" }).unref();
  else if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  else spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

// One copy only. Opening the app again shows the window of the one that is running.
const existing = readRunning();
if (args.includes("--quit")) {
  // The installer and uninstaller go on as soon as this returns, so it returns once the app is gone.
  let gone = true;
  if (await isAlive(existing)) {
    await call(existing!, "/api/quit", "POST");
    gone = await waitUntilGone(existing!);
  }
  process.exit(gone ? 0 : 1);
}
if (await isAlive(existing)) {
  openWindow(`http://127.0.0.1:${existing!.port}/?t=${existing!.token}`);
  process.exit(0);
}

// A shortcut starts a console program. It hands over to a copy with no console, and is gone.
if (!args.includes("--child") && !args.includes("--foreground")) {
  spawn(process.execPath, [process.argv[1], "--child", ...args], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  process.exit(0);
}

const token = randomBytes(24).toString("hex");
const service = new ProviderService();
const installed = { node: process.execPath, app: process.argv[1] };

const record = (what: string, e: unknown) => {
  const text = e instanceof Error ? e.stack ?? e.message : String(e);
  try {
    mkdirSync(HOME, { recursive: true });
    appendFileSync(join(HOME, "crash.log"), `${new Date().toISOString()} ${what}: ${text}\n`);
  } catch {
    // nowhere to write it, the app goes on regardless
  }
};

// A bug must not leave a stranger's workspace running on this PC with nobody watching it.
let crashing = false;
process.on("uncaughtException", (e) => {
  record("uncaught exception", e);
  if (crashing) return;
  crashing = true;
  setTimeout(die, 30_000).unref();
  service
    .stop()
    .catch(() => {})
    .then(() => service.removeLeftovers())
    .catch(() => {})
    .finally(die);
});
// A promise that failed on its own is one action that failed, not a broken app: noted, and it goes on.
process.on("unhandledRejection", (e) => {
  record("unhandled rejection", e);
  service.note(`Something failed in the background: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300));
});

// Only this PC can reach it, and only this app's page knows the token. Another website the owner has
// open cannot press Start, and cannot reach it by renaming itself to this address.
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://local");
  const json = (status: number, data: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(data));
  };
  const host = req.headers.host ?? "";
  if (!/^127\.0\.0\.1:\d+$/.test(host)) return json(403, { error: "wrong host" });

  if (req.method === "GET" && url.pathname === "/") {
    if (url.searchParams.get("t") !== token) return json(403, { error: "open the app from its shortcut" });
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
      "x-frame-options": "DENY",
    });
    return res.end(uiHtml);
  }
  if (req.headers["x-token"] !== token) return json(403, { error: "no token" });

  try {
    if (req.method === "GET" && url.pathname === "/health") return json(200, { ok: true });
    if (req.method === "GET" && url.pathname === "/api/state") return json(200, { ...service.state, running: service.running });
    if (req.method !== "POST") return json(404, { error: "not found" });

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 16_384) return json(413, { error: "too large" });
      chunks.push(c as Buffer);
    }
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};

    switch (url.pathname) {
      case "/api/save": {
        const { payout, hourlyUsd, coordinator } = body;
        const error = service.saveConfig({
          ...(payout !== undefined && { payout: String(payout).trim() }),
          ...(hourlyUsd !== undefined && { hourlyUsd: Number(hourlyUsd) }),
          ...(coordinator !== undefined && { coordinator: String(coordinator).trim() }),
        });
        return json(error ? 400 : 200, error ? { error } : { ok: true });
      }
      case "/api/consent":
        service.saveConfig({ allowPlainDocker: body.allow === true });
        return json(200, { ok: true });
      case "/api/start": {
        const error = await service.start();
        return json(error ? 400 : 200, error ? { error } : { ok: true });
      }
      case "/api/stop":
        await service.stop();
        return json(200, { ok: true });
      case "/api/install":
        await service.install(body.what === "wsl" ? "wsl" : "docker");
        return json(200, { ok: true });
      case "/api/start-docker":
        service.startDocker();
        return json(200, { ok: true });
      case "/api/autostart": {
        const error = await service.setAutostart(body.on === true, installed);
        return json(error ? 400 : 200, error ? { error } : { ok: true });
      }
      case "/api/quit":
        json(200, { ok: true });
        await service.stop();
        die();
    }
    json(404, { error: "not found" });
  } catch (e) {
    json(500, { error: e instanceof Error ? e.message : "failed" });
  }
});

function listen(port: number) {
  server.once("error", () => listen(0)); // the usual port is taken, any will do
  server.listen(port, "127.0.0.1", () => {
    const actual = (server.address() as { port: number }).port;
    mkdirSync(HOME, { recursive: true });
    writeFileSync(FILE, JSON.stringify({ port: actual, token, pid: process.pid }), { mode: 0o600 });
    openWindow(`http://127.0.0.1:${actual}/?t=${token}`);
    if (args.includes("--print-url")) console.log(`http://127.0.0.1:${actual}/?t=${token}`);
  });
}
listen(FIRST_PORT);

// Workspaces of this app (by their label) that a crash left behind. Docker may not be up yet, then
// they are removed before renting starts.
await service.removeLeftovers().catch(() => {});

// Started with Windows: goes back to renting, if the owner turned that on. At login Docker is often
// still starting, so the periodic check keeps trying until it rents or the owner presses Stop.
if (args.includes("--background") && service.state.config.autostart) service.resumeWanted = true;
const tick = () => service.tick().catch((e) => service.note(`Could not check this PC: ${e instanceof Error ? e.message : e}`));
void tick();
setInterval(tick, 8_000);

const shutdown = async () => {
  await service.stop().catch(() => {});
  die();
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
