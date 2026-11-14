// The agent that runs inside a rented cloud GPU machine. It connects the machine to the coordinator like any other
// machine, and runs the renter's commands in /workspace. It is bundled into one file and downloaded by the machine's start script.
//   COORDINATOR=https://gpuhub.app PAYOUT=0x... HOURLY_USD=0.39 GPUHUB_MACHINE_KEY=0x... node cloud-agent.mjs
import { isAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ProviderClient } from "./client.ts";
import { TORCH_IMAGE } from "./docker.ts";
import { NativeRunner } from "./native.ts";
import { detectSpecs } from "./specs.ts";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const key = process.env.GPUHUB_MACHINE_KEY ?? "";
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) fail("GPUHUB_MACHINE_KEY must be a 0x private key made for this machine only.");
const payout = process.env.PAYOUT ?? "";
if (!isAddress(payout)) fail("Set PAYOUT to the wallet that is paid for this machine.");
const hourly = Number(process.env.HOURLY_USD);
if (!Number.isFinite(hourly) || hourly <= 0) fail("HOURLY_USD must be a positive number of dollars.");

const url = new URL(process.env.COORDINATOR ?? "");
if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) fail("COORDINATOR must be https.");
url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
url.pathname = "/machine";

const specs = await detectSpecs();
// the rented machine lists what it really has, the coordinator checks it again with a benchmark
const client = new ProviderClient({
  url: url.toString(),
  account: privateKeyToAccount(key as Hex),
  payout,
  specs,
  hourlyUnits: BigInt(Math.round(hourly * 1e6)),
  images: [TORCH_IMAGE],
  isolation: "docker",
  runner: new NativeRunner(process.env.WORKSPACE ?? "/workspace"),
});
client.connect();
console.log(`cloud agent started, ${specs.cpuCores} cores, ${specs.ramGb} GB, ${specs.gpu ? `${specs.gpu.name} ${specs.gpu.vramGb} GB` : "no GPU"}, ${hourly} an hour`);

const shutdown = async () => {
  await client.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
