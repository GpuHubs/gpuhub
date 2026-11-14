// What the desktop app does, apart from showing it: checks the PC, prepares images, rents out.
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { isAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ProviderClient } from "./client.ts";
import { DEFAULT_IMAGE, DockerRunner, TORCH_IMAGE, runDocker, type Isolation } from "./docker.ts";
import { detectSpecs, type Specs } from "./specs.ts";

export const HOME = process.env.GPUHUB_HOME ?? join(homedir(), ".gpuhub");
const CONFIG_FILE = join(HOME, "config.json");

/** The marketplace this build talks to. Set when the installer is built. */
declare const BUILD_COORDINATOR: string | undefined;
const DEFAULT_COORDINATOR = process.env.COORDINATOR ?? (typeof BUILD_COORDINATOR === "string" ? BUILD_COORDINATOR : "http://localhost:8787");

export interface Config {
  payout: string;
  hourlyUsd: number;
  coordinator: string;
  /** The owner's own decision to rent out with Docker's weaker isolation. */
  allowPlainDocker: boolean;
  /** Starts renting by itself when the PC starts. */
  autostart: boolean;
}

export type Phase = "checking" | "needs-wsl" | "needs-docker" | "docker-stopped" | "ready" | "preparing" | "needs-consent" | "connecting" | "online" | "rented" | "error";

export interface State {
  phase: Phase;
  detail: string;
  config: Config;
  specs: Specs | null;
  /** What would be offered, after limits. */
  offer: { cpus: number; memoryGb: number } | null;
  isolation: Isolation | null;
  gpuOffered: boolean;
  images: string[];
  rentals: number;
  earned: { claimable: string; pending: string; symbol: string } | null;
  log: string[];
}

/** Prices travel as millionths of a dollar. The cheapest listing is $0.001 an hour. */
export const MIN_HOURLY_UNITS = 1_000n;
export const MAX_HOURLY_USD = 50;
export const hourlyUnits = (usd: number) => BigInt(Math.round(usd * 1e6));

/** Null when the price can be listed, otherwise what is wrong with it. */
export function priceError(usd: number): string | null {
  if (!Number.isFinite(usd) || usd > MAX_HOURLY_USD || hourlyUnits(usd) < MIN_HOURLY_UNITS) return "The price must be between $0.001 and $50 an hour.";
  return null;
}

/**
 * A PowerShell single-quoted string. Inside one, only a quote is special, and it is written twice.
 * PowerShell also takes the curly quotes for one, so those are doubled as well.
 */
export const psQuote = (s: string) => `'${s.replace(/['‘’‚‛]/g, (q) => q + q)}'`;

/** The script that creates or removes the Startup shortcut. It fails with a non-zero exit code. */
export function autostartScript(on: boolean, link: string, install: { node: string; app: string }): string {
  return on
    ? [
        "$ErrorActionPreference='Stop'",
        `$s=(New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(link)})`,
        `$s.TargetPath=${psQuote(install.node)}`,
        `$s.Arguments=${psQuote(`"${install.app}" --background`)}`,
        "$s.WindowStyle=7",
        "$s.Save()",
        `if (-not (Test-Path -LiteralPath ${psQuote(link)})) { exit 1 }`,
      ].join(";")
    : `$ErrorActionPreference='Stop';if (Test-Path -LiteralPath ${psQuote(link)}) { Remove-Item -LiteralPath ${psQuote(link)} }`;
}

export function socketUrl(http: string): string {
  const u = new URL(http);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname))) {
    throw new Error("The marketplace address must be https, or http on this PC.");
  }
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/machine";
  return u.toString();
}

/** Identity of this PC for the marketplace. Holds no funds, payouts go to the payout address. */
export function machineKey(): Hex {
  const file = join(HOME, "machine.key");
  if (existsSync(file)) return readFileSync(file, "utf8").trim() as Hex;
  mkdirSync(HOME, { recursive: true });
  const key = generatePrivateKey();
  writeFileSync(file, key, { mode: 0o600 });
  chmodSync(file, 0o600);
  return key;
}

/** A listing must not promise more than Docker can give, its VM may be smaller than the PC. */
export function shareLimits(specs: Specs, capacity: { cpus: number; memoryGb: number } | null) {
  const cpus = Math.min(Number(process.env.SHARE_CPUS ?? Math.max(1, specs.cpuCores - 2)), capacity?.cpus ?? Infinity);
  const memoryGb = Math.floor(Math.min(Number(process.env.SHARE_RAM_GB ?? Math.max(1, specs.ramGb * 0.7)), capacity?.memoryGb ?? Infinity) * 10) / 10;
  return { cpus, memoryGb };
}

export type IsolationDecision =
  | { ok: true; isolation: Isolation; offerGpu: boolean; note: string }
  | { ok: false; reason: string };

/** A stranger's code runs here, so the safe choice is the default and the weaker one is a decision. */
export function decideIsolation(probe: { works: boolean; gpu: boolean; reason: string }, hasGpu: boolean, allowPlainDocker: boolean): IsolationDecision {
  if (probe.works) {
    if (!hasGpu || probe.gpu) return { ok: true, isolation: "gvisor", offerGpu: hasGpu, note: "" };
    if (allowPlainDocker) return { ok: true, isolation: "docker", offerGpu: true, note: `${probe.reason} The GPU is offered with Docker's weaker isolation, as you allowed.` };
    return { ok: true, isolation: "gvisor", offerGpu: false, note: `${probe.reason} Offering CPU only, under gVisor.` };
  }
  if (allowPlainDocker) return { ok: true, isolation: "docker", offerGpu: hasGpu, note: "gVisor is not available here, using Docker's weaker isolation, as you allowed." };
  return { ok: false, reason: probe.reason };
}

function findDocker(): string[] {
  if (process.env.DOCKER_CMD) return JSON.parse(process.env.DOCKER_CMD);
  const windows = "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe";
  return platform() === "win32" && existsSync(windows) ? [windows] : ["docker"];
}

const run = (file: string, args: string[], timeout = 15_000) =>
  new Promise<{ ok: boolean; out: string }>((resolve) => {
    execFile(file, args, { timeout, windowsHide: true }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr}` }));
  });

export class ProviderService {
  private docker = findDocker();
  private client: ProviderClient | null = null;
  private runner: DockerRunner | null = null;
  private earningsTimer?: NodeJS.Timeout;
  private busy = false;
  private ticking = false;
  private lastResumeTry = 0;
  /** Started with Windows and autostart is on: keep trying until it rents, or the owner presses Stop. */
  resumeWanted = false;
  state: State = {
    phase: "checking",
    detail: "Checking this PC…",
    config: this.loadConfig(),
    specs: null,
    offer: null,
    isolation: null,
    gpuOffered: false,
    images: [],
    rentals: 0,
    earned: null,
    log: [],
  };

  private loadConfig(): Config {
    const fallback: Config = { payout: "", hourlyUsd: 0.05, coordinator: DEFAULT_COORDINATOR, allowPlainDocker: false, autostart: false };
    try {
      return { ...fallback, ...JSON.parse(readFileSync(CONFIG_FILE, "utf8")) };
    } catch {
      return fallback;
    }
  }

  saveConfig(next: Partial<Config>): string | null {
    const c = { ...this.state.config, ...next };
    if (c.payout && !isAddress(c.payout)) return "That does not look like a wallet address. It starts with 0x and has 40 more characters.";
    const badPrice = priceError(c.hourlyUsd);
    if (badPrice) return badPrice;
    try {
      socketUrl(c.coordinator);
    } catch (e) {
      return e instanceof Error ? e.message : "Bad marketplace address.";
    }
    this.state.config = c;
    mkdirSync(HOME, { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2));
    return null;
  }

  /** A line in the app's log, for problems the app noticed and survived. */
  note(m: string) {
    this.say(m);
  }

  /** Removes workspaces this app created (by its label) that an earlier crash left running. */
  async removeLeftovers() {
    await new DockerRunner({ cpus: 1, memoryGb: 1, workspaceGb: 1, gpu: false }, this.docker).stopAll();
  }

  /**
   * The periodic look at the PC. At login Docker is often not up yet, so a start with Windows is
   * tried again here once Docker answers, at most once a minute.
   */
  async tick(now = Date.now()) {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.check();
      if (!this.resumeWanted || !this.state.config.autostart || this.client || this.busy) return;
      if (this.state.phase !== "ready" || now - this.lastResumeTry < 60_000) return;
      this.lastResumeTry = now;
      const error = await this.start();
      if (error) this.say(`Could not start renting by itself: ${error}`);
    } finally {
      this.ticking = false;
    }
  }

  private say(m: string) {
    this.state.log = [...this.state.log, m].slice(-40);
  }

  private set(phase: Phase, detail: string) {
    this.state.phase = phase;
    this.state.detail = detail;
  }

  get running() {
    return this.client !== null;
  }

  /** Looks at the PC. Changes nothing, and does nothing while renting. */
  async check() {
    if (this.client || this.busy) return;
    if (!this.state.specs) this.state.specs = await detectSpecs();
    if (platform() === "win32" && !existsSync("C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe") && !process.env.DOCKER_CMD) {
      const wsl = await run("wsl", ["--status"]);
      // Without the WSL feature, wsl.exe exists and answers with an error.
      if (!wsl.ok) return this.set("needs-wsl", "Windows needs a free component first, then a restart.");
      return this.set("needs-docker", "Docker runs the rented workspaces safely apart from your PC. It is free.");
    }
    const version = await runDocker(this.docker, ["version", "--format", "{{.Server.Version}}"], 15_000).catch(() => null);
    if (!version) return this.set("needs-docker", "Docker runs the rented workspaces safely apart from your PC. It is free.");
    if (version.exitCode !== 0) return this.set("docker-stopped", "Docker is installed but not running.");
    const probeRunner = new DockerRunner({ cpus: 1, memoryGb: 1, workspaceGb: 1, gpu: false }, this.docker);
    this.state.offer = shareLimits(this.state.specs, await probeRunner.capacity());
    this.state.images = await probeRunner.readyImages();
    if (this.state.phase !== "needs-consent" || this.state.config.allowPlainDocker) this.set("ready", "Ready to rent out this PC.");
  }

  /** Opens the Windows prompts for what is missing. The owner approves each one there. */
  async install(what: "wsl" | "docker") {
    const script = what === "wsl" ? "wsl --install --no-distribution; Read-Host 'Done. Restart your PC, then press Enter to close'" : "winget install -e --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements; Read-Host 'Done. Press Enter to close'";
    spawn("powershell", ["-NoProfile", "-Command", `Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-Command',"${script}"`], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    this.say(what === "wsl" ? "Opened the Windows component setup." : "Opened the Docker setup.");
  }

  startDocker() {
    const app = "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe";
    if (existsSync(app)) spawn(app, [], { detached: true, stdio: "ignore" }).unref();
    this.set("docker-stopped", "Starting Docker, this takes about a minute…");
  }

  /** Downloads what is missing, one image at a time, showing how far it got. */
  private async pull(image: string) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.docker[0], [...this.docker.slice(1), "pull", image], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      const layers = new Set<string>();
      const done = new Set<string>();
      let tail = "";
      const onData = (d: Buffer) => {
        tail += d.toString("utf8");
        const lines = tail.split(/\r?\n/);
        tail = lines.pop() ?? "";
        for (const line of lines) {
          const m = line.match(/^([0-9a-f]{12}): (.+)$/);
          if (!m) continue;
          layers.add(m[1]);
          if (/complete|exists/i.test(m[2])) done.add(m[1]);
        }
        this.state.detail = `Downloading ${image.split(":")[0]}: ${done.size} of ${layers.size || "?"} parts. This happens once.`;
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`could not download ${image}`))));
    });
  }

  async start(): Promise<string | null> {
    if (this.client || this.busy) return null;
    const c = this.state.config;
    if (!isAddress(c.payout)) return "Add the wallet address your earnings go to.";
    // A config saved by an older version may hold a price that rounds to nothing, which is free rent.
    const badPrice = priceError(c.hourlyUsd);
    if (badPrice) return badPrice;
    this.busy = true;
    try {
      const specs = this.state.specs ?? (await detectSpecs());
      const probeRunner = new DockerRunner({ cpus: 1, memoryGb: 1, workspaceGb: 1, gpu: false }, this.docker);
      if ((await runDocker(this.docker, ["version", "--format", "{{.Server.Version}}"], 15_000).catch(() => null))?.exitCode !== 0) {
        this.set("docker-stopped", "Docker is not running.");
        return "Start Docker first.";
      }
      const { cpus, memoryGb } = shareLimits(specs, await probeRunner.capacity());
      this.state.offer = { cpus, memoryGb };

      this.set("preparing", "Preparing…");
      const wanted = [DEFAULT_IMAGE, ...(specs.gpu ? [TORCH_IMAGE] : [])];
      const before = await probeRunner.readyImages();
      for (const image of wanted.filter((w) => !before.includes(w))) await this.pull(image);
      const images = await probeRunner.readyImages();
      this.state.images = images;
      if (images.length === 0) throw new Error("no workspace image is available");

      const probe = await probeRunner.probeGvisor(images[0], !!specs.gpu);
      const decision = decideIsolation(probe, !!specs.gpu, c.allowPlainDocker);
      if (!decision.ok) {
        this.set("needs-consent", "Stronger isolation (gVisor) is not available on this PC. It is your choice whether to go on with Docker's own.");
        return null;
      }
      if (decision.note) this.say(decision.note);
      await probeRunner.stopAll();

      const runner = new DockerRunner({ cpus, memoryGb, workspaceGb: memoryGb, gpu: decision.offerGpu, runtime: decision.isolation === "gvisor" ? "runsc" : undefined }, this.docker);
      this.runner = runner;
      this.state.isolation = decision.isolation;
      this.state.gpuOffered = decision.offerGpu;
      this.set("connecting", "Connecting to the marketplace…");
      this.client = new ProviderClient({
        url: socketUrl(c.coordinator),
        account: privateKeyToAccount(machineKey()),
        payout: c.payout,
        specs: { ...specs, cpuCores: cpus, ramGb: memoryGb, gpu: decision.offerGpu ? specs.gpu : null },
        hourlyUnits: hourlyUnits(c.hourlyUsd),
        images,
        isolation: decision.isolation,
        runner,
        log: (m) => this.onClientLog(m),
      });
      this.client.connect();
      this.earningsTimer = setInterval(() => void this.loadEarnings(), 15_000);
      void this.loadEarnings();
      return null;
    } catch (e) {
      this.set("error", e instanceof Error ? e.message : "Something failed.");
      return null;
    } finally {
      this.busy = false;
    }
  }

  private onClientLog(m: string) {
    if (m.startsWith("online as")) this.set("online", `Listed at $${this.state.config.hourlyUsd} an hour, waiting for a renter.`);
    else if (m.startsWith("rented:")) {
      this.state.rentals++;
      this.set("rented", "Rented right now, your earnings are adding up.");
    } else if (/ ended$|stopped by itself/.test(m)) {
      this.set("online", `Listed at $${this.state.config.hourlyUsd} an hour, waiting for a renter.`);
      void this.loadEarnings();
    } else if (m.startsWith("disconnected") || m.startsWith("connection error")) {
      this.set("connecting", "Can't reach the marketplace, trying again…");
    } else if (m.startsWith("refused")) {
      this.set("error", `The marketplace refused this PC: ${m.replace(/^refused by the coordinator: /, "")}`);
    }
    this.say(m);
  }

  private async loadEarnings() {
    const { payout, coordinator } = this.state.config;
    if (!isAddress(payout)) return;
    try {
      const [p, s] = await Promise.all([
        fetch(new URL(`/api/provider/${payout}`, coordinator)).then((r) => r.json() as Promise<any>),
        fetch(new URL("/api/stats", coordinator)).then((r) => r.json() as Promise<any>),
      ]);
      this.state.earned = { claimable: p.claimableTokens, pending: p.pendingUsdUnits, symbol: s.symbol ?? "GHUB" };
    } catch {
      // The status line already says when the marketplace is away.
    }
  }

  /** Ends any rental and removes its workspace. */
  async stop() {
    this.resumeWanted = false; // the owner's Stop wins over autostart until the next login
    clearInterval(this.earningsTimer);
    const client = this.client;
    this.client = null;
    this.state.isolation = null;
    this.set("checking", "Stopping…");
    await client?.close();
    await this.check();
  }

  /** A shortcut in the Windows Startup folder, so renting resumes after a restart. */
  /** Null when done, otherwise why not. Autostart is saved as on only once the shortcut exists. */
  async setAutostart(on: boolean, install: { node: string; app: string } | null): Promise<string | null> {
    if (platform() !== "win32" || !install) return this.saveConfig({ autostart: on });
    const folder = join(process.env.APPDATA ?? "", "Microsoft\\Windows\\Start Menu\\Programs\\Startup");
    const link = join(folder, "GPUhub Provider.lnk");
    // Encoded, so no path is parsed again by a command line on its way to PowerShell.
    const encoded = Buffer.from(autostartScript(on, link, install), "utf16le").toString("base64");
    const r = await run("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], 20_000);
    if (!on) {
      // Off is saved either way: a shortcut left behind only opens the app, which then stays idle.
      const error = this.saveConfig({ autostart: false });
      return error ?? (r.ok ? null : "Autostart is off, but the Startup shortcut could not be removed.");
    }
    if (!r.ok) {
      const why = r.out.replace(/\s+/g, " ").trim().slice(0, 200);
      this.say(`Could not create the Startup shortcut: ${why || "PowerShell failed"}`);
      return "Could not create the Startup shortcut, so renting will not start with Windows.";
    }
    return this.saveConfig({ autostart: true });
  }
}
