// Runs a renter's commands directly in this machine's own /workspace folder, with no Docker around them.
// It is for a rented cloud machine whose whole container is the sandbox: it is destroyed when the session ends.
// It must not be used on someone's own PC, that is what DockerRunner and gVisor are for.
import { mkdirSync, readdirSync, rmSync, statSync, openSync, readSync, closeSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FILE_CHUNK_BYTES, runDocker, workspacePath, type ExecResult, type Runner } from "./docker.ts";

export class NativeRunner implements Runner {
  private root: string;
  private running = false;

  constructor(root = "/workspace") {
    this.root = root;
  }

  private target(path: string): string {
    const w = workspacePath(path);
    if (!w) throw new Error("the path must stay inside the workspace");
    return join(this.root, w.slice("/workspace/".length));
  }

  async start(_sessionId: string, _image: string | undefined) {
    mkdirSync(this.root, { recursive: true });
    this.running = true;
  }

  async exec(_sessionId: string, command: string, timeoutMs: number): Promise<ExecResult> {
    const secs = String(Math.max(1, Math.ceil(timeoutMs / 1000)));
    // timeout kills the whole command, the CLI limit below is a backstop
    const r = await runDocker(["timeout", "--signal=KILL", secs, "sh", "-c", `cd "$1" && exec sh -c "$2"`, "sh", this.root, command], [], timeoutMs + 10_000);
    const hitLimit = r.exitCode === 137;
    return { ...r, timedOut: r.timedOut || hitLimit };
  }

  async writeFile(_sessionId: string, path: string, base64: string, append: boolean) {
    const file = this.target(path);
    if (base64.length > Math.ceil(FILE_CHUNK_BYTES / 3) * 4) throw new Error("this piece of the file is too large");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error("the data is not base64");
    mkdirSync(dirname(file), { recursive: true });
    const data = Buffer.from(base64, "base64");
    if (append) appendFileSync(file, data);
    else writeFileSync(file, data);
    return { ok: true as const };
  }

  async readFile(_sessionId: string, path: string, offset: number, length: number) {
    const file = this.target(path);
    if (!Number.isInteger(offset) || offset < 0) throw new Error("bad offset");
    const want = Math.min(Number.isInteger(length) && length > 0 ? length : FILE_CHUNK_BYTES, FILE_CHUNK_BYTES);
    const size = statSync(file).size;
    const buf = Buffer.alloc(Math.max(0, Math.min(want, size - offset)));
    if (buf.length > 0) {
      const fd = openSync(file, "r");
      try {
        readSync(fd, buf, 0, buf.length, offset);
      } finally {
        closeSync(fd);
      }
    }
    return { size, offset, data: buf.toString("base64") };
  }

  async isRunning(_sessionId: string) {
    return this.running;
  }

  async stop(_sessionId: string) {
    await this.stopAll();
  }

  /** Empties the workspace, so one session never sees the files of the one before. */
  async stopAll() {
    this.running = false;
    try {
      for (const name of readdirSync(this.root)) rmSync(join(this.root, name), { recursive: true, force: true });
    } catch {
      // no workspace yet
    }
  }
}
