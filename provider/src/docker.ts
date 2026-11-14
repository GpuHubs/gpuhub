import { spawn } from "node:child_process";

/** Images a renter may start. The coordinator checks too, but this PC has the last word. */
export const TORCH_IMAGE = "pytorch/pytorch:2.14.1-cuda12.6-cudnn9-runtime";
export const ALLOWED_IMAGES = ["python:3.12-slim", "ubuntu:24.04", TORCH_IMAGE];
export const DEFAULT_IMAGE = "python:3.12-slim";
export const MAX_OUTPUT_BYTES = 1024 * 1024;
/** Largest piece of a file in one message, in raw bytes. Bigger files go in several pieces. */
export const FILE_CHUNK_BYTES = 8 * 1024 * 1024;

export interface Limits {
  cpus: number;
  memoryGb: number;
  workspaceGb: number;
  gpu: boolean;
  /** "runsc" is gVisor: the code talks to a kernel of gVisor's, not to this PC's. */
  runtime?: string;
}

export type Isolation = "gvisor" | "docker";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

export interface Runner {
  start(sessionId: string, image: string | undefined): Promise<void>;
  exec(sessionId: string, command: string, timeoutMs: number): Promise<ExecResult>;
  writeFile(sessionId: string, path: string, base64: string, append: boolean): Promise<{ ok: true }>;
  readFile(sessionId: string, path: string, offset: number, length: number): Promise<{ size: number; offset: number; data: string }>;
  /** Whether the workspace still exists. It can die by itself, for example out of memory. */
  isRunning(sessionId: string): Promise<boolean>;
  stop(sessionId: string): Promise<void>;
  stopAll(): Promise<void>;
}

/** A path inside the workspace. Returns null for anything that tries to leave it. */
export function workspacePath(path: unknown): string | null {
  if (typeof path !== "string" || !path || path.length > 1024 || path.includes("\0")) return null;
  const clean = path.replace(/\\/g, "/");
  if (clean.startsWith("/") || /^[a-zA-Z]:/.test(clean)) return null;
  if (clean.split("/").some((part) => part === "..")) return null;
  return `/workspace/${clean}`;
}

const LABEL = "gpuhub=1";
export const containerName = (sessionId: string) => `gpuhub-${sessionId.replace(/[^a-zA-Z0-9-]/g, "")}`;

/**
 * Isolation of a stranger's code from this PC. Keep this as the single place that decides it.
 * - No network: no access to the home network, and no attacks or scraping from this IP.
 * - Read-only image, not root, no extra Linux capabilities, no privilege escalation.
 * - Only private temporary disks. No folder of this PC is ever mounted.
 * - Limits on CPU, memory and processes, so the PC stays usable.
 */
/** Whole megabytes: Docker's disks refuse a size like 3.5g, and memory is often not a whole number. */
const megabytes = (gb: number) => `${Math.floor(gb * 1024)}m`;

export function runArgs(sessionId: string, image: string, l: Limits): string[] {
  return [
    "run", "--detach", "--rm",
    // A renter's request must never download anything to this PC. Images are prepared beforehand.
    "--pull", "never",
    "--name", containerName(sessionId),
    "--label", LABEL,
    ...(l.runtime ? ["--runtime", l.runtime] : []),
    "--network", "none",
    "--read-only",
    "--user", "1000:1000",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "512",
    // A real init cleans up finished processes. Under a bare "sleep" they stay as zombies, fill the
    // process limit for good, and after that no command can start.
    "--init",
    "--cpus", String(l.cpus),
    "--memory", megabytes(l.memoryGb),
    "--memory-swap", megabytes(l.memoryGb),
    // "exec": Docker's temporary disks forbid running programs by default, a workspace needs to.
    "--tmpfs", `/workspace:rw,exec,size=${megabytes(l.workspaceGb)},uid=1000,gid=1000`,
    "--tmpfs", "/tmp:rw,size=1g,uid=1000,gid=1000",
    // PyTorch data loaders share memory here, Docker's default of 64 MB breaks them.
    "--shm-size", "1g",
    "--workdir", "/workspace",
    "--env", "HOME=/workspace",
    ...(l.gpu ? ["--gpus", "all"] : []),
    image,
    "sleep", "infinity",
  ];
}

/**
 * The time limit is enforced inside the container: stopping the Docker CLI on this PC would leave
 * the command running there.
 */
export const execArgs = (sessionId: string, command: string, timeoutMs: number) => [
  "exec", containerName(sessionId),
  "timeout", "--signal=KILL", String(Math.max(1, Math.ceil(timeoutMs / 1000))),
  "sh", "-c", command,
];

/** Decodes what arrives on stdin into a workspace file. Paths are arguments, never part of the script. */
export const writeFileArgs = (sessionId: string, path: string, append: boolean) => [
  "exec", "-i", containerName(sessionId),
  "timeout", "--signal=KILL", "120",
  "sh", "-c", `mkdir -p "$(dirname "$1")" && base64 -d ${append ? ">>" : ">"} "$1"`, "sh", path,
];

/** Prints the file size, then a piece of it in base64. */
export const readFileArgs = (sessionId: string, path: string, offset: number, length: number) => [
  "exec", containerName(sessionId),
  "timeout", "--signal=KILL", "120",
  "sh", "-c", 'stat -c %s "$1" && tail -c +"$2" "$1" | head -c "$3" | base64 -w0', "sh", path, String(offset + 1), String(length),
];

interface RunOutput extends ExecResult {}
interface RunOptions {
  stdin?: string;
  maxOutput?: number;
}

/** Runs the Docker CLI with an argument list. Nothing goes through a shell on this PC. */
export function runDocker(cmd: string[], args: string[], timeoutMs: number, opts: RunOptions = {}): Promise<RunOutput> {
  const maxOutput = opts.maxOutput ?? MAX_OUTPUT_BYTES;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0], [...cmd.slice(1), ...args], { stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"], windowsHide: true });
    if (opts.stdin !== undefined) {
      child.stdin!.on("error", () => {}); // the exit code reports a failure
      child.stdin!.end(opts.stdin);
    }
    const out = { stdout: "", stderr: "", truncated: false };
    const collect = (name: "stdout" | "stderr") => (chunk: Buffer) => {
      if (out.stdout.length + out.stderr.length + chunk.length > maxOutput) {
        out.truncated = true;
        const room = maxOutput - out.stdout.length - out.stderr.length;
        if (room > 0) out[name] += chunk.subarray(0, room).toString("utf8");
        return;
      }
      out[name] += chunk.toString("utf8");
    };
    child.stdout!.on("data", collect("stdout"));
    child.stderr!.on("data", collect("stderr"));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ ...out, exitCode, timedOut });
    });
  });
}

/** Reads `docker info --format "{{.NCPU}} {{.MemTotal}}"`. */
export function parseCapacity(output: string): { cpus: number; memoryGb: number } | null {
  const [cpus, bytes] = output.trim().split(/\s+/).map(Number);
  if (!(cpus > 0) || !(bytes > 0)) return null;
  return { cpus, memoryGb: bytes / 1024 ** 3 };
}

export class DockerRunner implements Runner {
  private cmd: string[];
  private limits: Limits;

  /** DOCKER_CMD is a JSON list, so a path with spaces stays one argument. */
  constructor(limits: Limits, cmd: string[] = process.env.DOCKER_CMD ? JSON.parse(process.env.DOCKER_CMD) : ["docker"]) {
    this.limits = limits;
    this.cmd = cmd;
  }

  /** Gives a clear message when Docker is missing or stopped. */
  async check() {
    const r = await runDocker(this.cmd, ["version", "--format", "{{.Server.Version}}"], 15_000).catch(() => null);
    if (!r || r.exitCode !== 0) throw new Error("Docker is not available. Install Docker and start it, then try again.");
    return r.stdout.trim();
  }

  async start(sessionId: string, image: string | undefined) {
    const chosen = image ?? DEFAULT_IMAGE;
    if (!ALLOWED_IMAGES.includes(chosen)) throw new Error(`image not allowed: ${chosen}`);
    const started = await runDocker(this.cmd, runArgs(sessionId, chosen, this.limits), 120_000);
    if (started.exitCode !== 0) throw new Error(`could not start the workspace: ${started.stderr.trim().slice(0, 300)}`);
  }

  async exec(sessionId: string, command: string, timeoutMs: number) {
    const started = Date.now();
    // The CLI gets a little longer, as a backstop in case the container itself stops answering.
    const r = await runDocker(this.cmd, execArgs(sessionId, command, timeoutMs), timeoutMs + 10_000);
    // 137 is SIGKILL. It also means out of memory, so the elapsed time tells them apart.
    const hitLimit = r.exitCode === 137 && Date.now() - started >= timeoutMs;
    return { ...r, timedOut: r.timedOut || hitLimit };
  }

  async writeFile(sessionId: string, path: string, base64: string, append: boolean) {
    const target = workspacePath(path);
    if (!target) throw new Error("the path must stay inside the workspace");
    if (base64.length > Math.ceil(FILE_CHUNK_BYTES / 3) * 4) throw new Error("this piece of the file is too large");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error("the data is not base64");
    const r = await runDocker(this.cmd, writeFileArgs(sessionId, target, append), 130_000, { stdin: base64 });
    if (r.exitCode !== 0) throw new Error(`could not write the file: ${r.stderr.trim().slice(0, 300)}`);
    return { ok: true as const };
  }

  async readFile(sessionId: string, path: string, offset: number, length: number) {
    const target = workspacePath(path);
    if (!target) throw new Error("the path must stay inside the workspace");
    if (!Number.isInteger(offset) || offset < 0) throw new Error("bad offset");
    const size = Math.min(Number.isInteger(length) && length > 0 ? length : FILE_CHUNK_BYTES, FILE_CHUNK_BYTES);
    const r = await runDocker(this.cmd, readFileArgs(sessionId, target, offset, size), 130_000, { maxOutput: FILE_CHUNK_BYTES * 2 });
    if (r.exitCode !== 0) throw new Error(`could not read the file: ${r.stderr.trim().slice(0, 300)}`);
    const nl = r.stdout.indexOf("\n");
    return { size: Number(r.stdout.slice(0, nl)), offset, data: r.stdout.slice(nl + 1).trim() };
  }

  /** Whether gVisor really runs here, and whether it can reach the GPU. Tried for real, not assumed. */
  async probeGvisor(image: string, wantGpu: boolean): Promise<{ works: boolean; gpu: boolean; reason: string }> {
    const info = await runDocker(this.cmd, ["info", "--format", "{{json .Runtimes}}"], 30_000).catch(() => null);
    if (!info || !info.stdout.includes('"runsc"')) return { works: false, gpu: false, reason: "Docker has no runsc runtime" };
    const base = ["run", "--rm", "--runtime", "runsc", "--network", "none", "--pull", "never"];
    const plain = await runDocker(this.cmd, [...base, image, "sh", "-c", "dmesg | head -n 1"], 120_000).catch(() => null);
    if (!plain || plain.exitCode !== 0) return { works: false, gpu: false, reason: `runsc failed: ${plain?.stderr.trim().slice(0, 200) ?? "no answer"}` };
    if (!wantGpu) return { works: true, gpu: false, reason: "" };
    const gpu = await runDocker(this.cmd, [...base, "--gpus", "all", image, "nvidia-smi", "-L"], 120_000).catch(() => null);
    return { works: true, gpu: gpu?.exitCode === 0, reason: gpu?.exitCode === 0 ? "" : `the GPU did not work under gVisor: ${gpu?.stderr.trim().slice(0, 200) ?? ""}` };
  }

  /** What Docker itself can use. On Windows and macOS it runs in a VM smaller than the PC. */
  async capacity(): Promise<{ cpus: number; memoryGb: number } | null> {
    const r = await runDocker(this.cmd, ["info", "--format", "{{.NCPU}} {{.MemTotal}}"], 30_000).catch(() => null);
    if (!r || r.exitCode !== 0) return null;
    return parseCapacity(r.stdout);
  }

  /** Images that are already on this PC. Only these can be rented. */
  async readyImages(): Promise<string[]> {
    const ready: string[] = [];
    for (const image of ALLOWED_IMAGES) {
      const r = await runDocker(this.cmd, ["image", "inspect", "--format", "ok", image], 30_000).catch(() => null);
      if (r?.exitCode === 0) ready.push(image);
    }
    return ready;
  }

  /** Downloads what this machine should offer. The PyTorch image is several GB. */
  async prepare(log: (m: string) => void) {
    const wanted = [DEFAULT_IMAGE, ...(this.limits.gpu ? [TORCH_IMAGE] : [])];
    const ready = await this.readyImages();
    for (const image of wanted.filter((w) => !ready.includes(w))) {
      log(`Downloading ${image}, this happens once and can take a while…`);
      const r = await runDocker(this.cmd, ["pull", image], 60 * 60_000);
      if (r.exitCode !== 0) log(`Could not download ${image}: ${r.stderr.trim().slice(0, 200)}`);
    }
    return this.readyImages();
  }

  async isRunning(sessionId: string) {
    const r = await runDocker(this.cmd, ["inspect", "--format", "{{.State.Running}}", containerName(sessionId)], 20_000).catch(() => null);
    // No answer from Docker says nothing about the container. It is taken as running, and asked again.
    if (!r) return true;
    return r.exitCode === 0 && r.stdout.trim() === "true";
  }

  async stop(sessionId: string) {
    await runDocker(this.cmd, ["rm", "--force", containerName(sessionId)], 30_000);
  }

  /** Removes every workspace of ours, also those left by an earlier crash. */
  async stopAll() {
    const r = await runDocker(this.cmd, ["ps", "--all", "--quiet", "--filter", `label=${LABEL}`], 30_000);
    const ids = r.stdout.split(/\s+/).filter(Boolean);
    if (ids.length) await runDocker(this.cmd, ["rm", "--force", ...ids], 60_000);
  }
}
