import { execFile } from "node:child_process";
import { cpus, platform, totalmem } from "node:os";

export interface Specs {
  cpuCores: number;
  ramGb: number;
  gpu: { name: string; vramGb: number } | null;
  os: string;
}

/** Parses `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`, first GPU. */
export function parseNvidiaSmi(output: string): Specs["gpu"] {
  const line = output.split("\n").map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  const parts = line.split(",").map((p) => p.trim());
  const mb = Number(parts[1]);
  if (parts.length < 2 || !parts[0] || !Number.isFinite(mb)) return null;
  return { name: parts[0], vramGb: Math.round((mb / 1024) * 10) / 10 };
}

function detectGpu(): Promise<Specs["gpu"]> {
  return new Promise((resolve) => {
    execFile("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], { timeout: 10_000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : parseNvidiaSmi(stdout));
    });
  });
}

export async function detectSpecs(): Promise<Specs> {
  return {
    cpuCores: cpus().length,
    ramGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    gpu: await detectGpu(),
    os: platform(),
  };
}
