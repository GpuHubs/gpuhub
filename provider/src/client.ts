import { createHash } from "node:crypto";
import WebSocket from "ws";
import type { PrivateKeyAccount } from "viem/accounts";
import type { Runner } from "./docker.ts";
import type { Specs } from "./specs.ts";

export function hashChain(nonce: string, iters: number): string {
  let h = createHash("sha256").update(nonce).digest();
  for (let i = 1; i < iters; i++) h = createHash("sha256").update(h).digest();
  return h.toString("hex");
}

/** The part of a socket this client writes to. Lets tests feed messages without a coordinator. */
export interface Sink {
  readyState: number;
  send(data: string): void;
}

export interface ClientOptions {
  url: string;
  account: PrivateKeyAccount;
  payout: string;
  specs: Specs;
  hourlyUnits: bigint;
  /** Container images ready on this PC. */
  images: string[];
  /** How strongly a renter's code is kept away from this PC. */
  isolation?: "gvisor" | "docker";
  runner: Runner;
  log?: (m: string) => void;
  heartbeatMs?: number;
}

/** Connects this PC to the coordinator. If the connection drops, all rented workspaces stop. */
export class ProviderClient {
  private o: ClientOptions;
  private ws: WebSocket | null = null;
  private closed = false;
  private retryMs = 1_000;
  private retry?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private active = new Set<string>();
  private log: (m: string) => void;

  constructor(o: ClientOptions) {
    this.o = o;
    this.log = o.log ?? console.log;
  }

  connect() {
    if (this.closed) return;
    const ws = new WebSocket(this.o.url, { maxPayload: 16 * 1024 * 1024 });
    this.ws = ws;
    ws.on("message", (raw) => void this.handleFrame(ws, raw.toString()));
    ws.on("error", (e) => this.log(`connection error: ${e.message}`));
    ws.on("close", (code, reason) => {
      clearInterval(this.heartbeat);
      if (this.ws !== ws) return;
      this.ws = null;
      // A renter cannot pay for or reach a workspace while we are away, so nothing keeps running.
      void this.stopEverything();
      if (this.closed) return;
      if (code === 4004 && String(reason) === "banned") {
        this.log("this machine was banned, not retrying");
        this.closed = true;
        return;
      }
      this.log(`disconnected (${code}), retrying in ${this.retryMs / 1000}s`);
      this.retry = setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 60_000);
    });
  }

  async close() {
    this.closed = true;
    clearTimeout(this.retry);
    clearInterval(this.heartbeat);
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, "provider stopped");
    await this.stopEverything();
  }

  /** A workspace that died by itself must stop being billed. */
  private async checkWorkspaces(send: (x: unknown) => void) {
    for (const id of [...this.active]) {
      if (await this.o.runner.isRunning(id).catch(() => true)) continue;
      if (this.active.delete(id)) {
        this.log(`session ${id}: the workspace stopped by itself`);
        send({ type: "session.lost", sessionId: id });
      }
    }
  }

  private async stopEverything() {
    this.active.clear();
    await this.o.runner.stopAll().catch((e) => this.log(`could not clean up: ${e.message}`));
  }

  /**
   * One frame from the coordinator. A frame that is not JSON, or a handler that fails, is logged and
   * answered with an error where it has an id. It must never take the app down, or the renter
   * containers would be left running.
   */
  async handleFrame(ws: Sink, text: string) {
    let m: any;
    try {
      m = JSON.parse(text);
    } catch {
      this.log("ignored a message that is not JSON");
      return;
    }
    if (!m || typeof m !== "object" || Array.isArray(m)) {
      this.log("ignored a message that is not an object");
      return;
    }
    try {
      await this.onMessage(ws, m);
    } catch (e) {
      const error = e instanceof Error ? e.message : "failed";
      this.log(`could not handle ${String(m.type).slice(0, 40)}: ${error}`);
      if (m.id !== undefined && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "reply", id: m.id, error }));
        } catch {
          // the socket is going away, its close handler cleans up
        }
      }
    }
  }

  private async onMessage(ws: Sink, m: any) {
    const send = (x: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(x));
    };
    switch (m.type) {
      case "challenge": {
        const signature = await this.o.account.signMessage({
          message: `gpuhub-machine:${m.challenge}:${this.o.payout.toLowerCase()}`,
        });
        send({
          type: "hello",
          key: this.o.account.address,
          payout: this.o.payout,
          kind: "container",
          specs: this.o.specs,
          hourlyUnits: this.o.hourlyUnits.toString(),
          images: this.o.images,
          isolation: this.o.isolation ?? "docker",
          signature,
        });
        break;
      }
      case "benchmark":
        send({ type: "benchmark.result", hash: hashChain(m.nonce, m.iters) });
        break;
      case "welcome":
        this.retryMs = 1_000;
        this.log(`online as ${m.id}, ${m.benchmark} hashes per second`);
        // A second welcome on the same connection must not leave the first timer running too.
        clearInterval(this.heartbeat);
        this.heartbeat = setInterval(() => {
          try {
            send({ type: "ping" });
          } catch {
            // the close handler deals with a dead socket
          }
          this.checkWorkspaces(send).catch((e) => this.log(`could not check workspaces: ${e instanceof Error ? e.message : e}`));
        }, this.o.heartbeatMs ?? 10_000);
        break;
      case "rejected":
        this.log(`refused by the coordinator: ${m.reason}`);
        break;
      case "session.start":
        try {
          await this.o.runner.start(m.sessionId, m.image);
          this.active.add(m.sessionId);
          this.log(`rented: session ${m.sessionId}`);
          send({ type: "reply", id: m.id, result: { ok: true } });
        } catch (e) {
          send({ type: "reply", id: m.id, error: e instanceof Error ? e.message : "could not start" });
        }
        break;
      case "session.exec":
        // A coordinator bug or attack must not reach a container this session does not own.
        if (!this.active.has(m.sessionId)) {
          send({ type: "reply", id: m.id, error: "no such workspace" });
          break;
        }
        try {
          const r = m.request ?? {};
          let result: unknown;
          if (typeof r.command === "string") result = await this.o.runner.exec(m.sessionId, r.command, m.timeoutMs);
          else if (r.write) result = await this.o.runner.writeFile(m.sessionId, r.write.path, r.write.data, !!r.write.append);
          else if (r.read) result = await this.o.runner.readFile(m.sessionId, r.read.path, r.read.offset, r.read.length);
          else throw new Error("bad request");
          send({ type: "reply", id: m.id, result });
          await this.checkWorkspaces(send);
        } catch (e) {
          send({ type: "reply", id: m.id, error: e instanceof Error ? e.message : "could not run" });
        }
        break;
      case "session.stop":
        if (this.active.delete(m.sessionId)) await this.o.runner.stop(m.sessionId).catch((e) => this.log(`could not stop: ${e.message}`));
        this.log(`session ${m.sessionId} ended`);
        send({ type: "reply", id: m.id, result: { ok: true } });
        break;
    }
  }
}
