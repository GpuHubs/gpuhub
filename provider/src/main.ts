// GPUhub provider: rents out this PC through isolated containers.
//   PAYOUT=0x... HOURLY_USD=0.10 node src/main.ts
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ProviderClient } from "./client.ts";
import { DockerRunner } from "./docker.ts";
import { decideIsolation } from "./service.ts";
import { detectSpecs } from "./specs.ts";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Identity of this PC for the coordinator. Holds no funds, payouts go to the payout address. */
function machineKey(): Hex {
  const dir = process.env.GPUHUB_HOME ?? join(homedir(), ".gpuhub");
  const file = join(dir, "machine.key");
  if (existsSync(file)) return readFileSync(file, "utf8").trim() as Hex;
  mkdirSync(dir, { recursive: true });
  const key = generatePrivateKey();
  writeFileSync(file, key, { mode: 0o600 });
  chmodSync(file, 0o600);
  return key;
}

function socketUrl(http: string): string {
  const u = new URL(http);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname))) {
    fail("COORDINATOR must be https, or http on this machine.");
  }
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/machine";
  return u.toString();
}

const payout = process.env.PAYOUT ?? "";
if (!isAddress(payout)) fail("Set PAYOUT to your wallet address. It needs no private key here.");

const specs = await detectSpecs();
const hourly = Number(process.env.HOURLY_USD ?? (specs.gpu ? "0.10" : "0.02"));
if (!Number.isFinite(hourly) || hourly <= 0) fail("HOURLY_USD must be a positive number of dollars.");

// Part of the PC stays free for its owner. The renter gets what is listed here, and no more.
// A listing must not promise more than Docker can give, its VM may be smaller than the PC.
const capacity = await new DockerRunner({ cpus: 1, memoryGb: 1, workspaceGb: 1, gpu: false }).capacity();
const cpus = Math.min(Number(process.env.SHARE_CPUS ?? Math.max(1, specs.cpuCores - 2)), capacity?.cpus ?? Infinity);
const memoryGb = Math.floor(Math.min(Number(process.env.SHARE_RAM_GB ?? Math.max(1, specs.ramGb * 0.7)), capacity?.memoryGb ?? Infinity) * 10) / 10;
const workspaceGb = Number(process.env.SHARE_DISK_GB ?? memoryGb);
const allowPlainDocker = process.env.ALLOW_PLAIN_DOCKER === "1";

const setup = new DockerRunner({ cpus, memoryGb, workspaceGb, gpu: !!specs.gpu });
const docker = await setup.check().catch((e) => fail(e.message));
await setup.stopAll();
const images = await setup.prepare((m) => console.log(m));
if (images.length === 0) fail("No container image is available, so there is nothing to rent out.");

const probe = await setup.probeGvisor(images[0], !!specs.gpu);
const decision = decideIsolation(probe, !!specs.gpu, allowPlainDocker);
if (!decision.ok) {
  fail(
    `gVisor is not available here: ${decision.reason}.\n` +
      "It keeps a stranger's code away from this PC's kernel. Install it (see the README) and start again.\n" +
      "To rent out this PC with Docker's weaker isolation anyway, set ALLOW_PLAIN_DOCKER=1.",
  );
}
const { isolation, offerGpu } = decision;
if (decision.note) console.log(decision.note);

const runner = new DockerRunner({ cpus, memoryGb, workspaceGb, gpu: offerGpu, runtime: isolation === "gvisor" ? "runsc" : undefined });
const listed = { ...specs, cpuCores: cpus, ramGb: memoryGb, gpu: offerGpu ? specs.gpu : null };
console.log(`Docker ${docker}, isolation: ${isolation === "gvisor" ? "gVisor" : "plain Docker"}. Offering ${cpus} CPU cores, ${memoryGb} GB RAM, ${offerGpu && specs.gpu ? `${specs.gpu.name} ${specs.gpu.vramGb} GB` : "no GPU"} at ${hourly} an hour.`);
console.log(`Images: ${images.join(", ")}`);
console.log("Containers have no network and see none of your files. Ctrl+C stops everything.");

const client = new ProviderClient({
  url: socketUrl(process.env.COORDINATOR ?? "http://localhost:8787"),
  account: privateKeyToAccount(machineKey()),
  payout,
  specs: listed,
  hourlyUnits: BigInt(Math.round(hourly * 1e6)),
  images,
  isolation,
  runner,
});
client.connect();

const shutdown = async () => {
  await client.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
