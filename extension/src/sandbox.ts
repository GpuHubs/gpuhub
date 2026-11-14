// Runs one piece of rented work, in a Worker of its own that the parent kills on timeout.
//
// A renter sends no JavaScript. WASM with no imports can only do arithmetic on its own memory, and
// WGSL can only compute on its own buffers, so neither can reach the network, files or this browser.

export const LIMITS = {
  moduleBytes: 8 * 1024 * 1024,
  wasmArgs: 16,
  readBytes: 8 * 1024 * 1024,
  wgslChars: 64 * 1024,
  gpuBufferBytes: 64 * 1024 * 1024,
  dispatchPerAxis: 4096,
  /** Linear memory a module may declare, initial and maximum alike. */
  wasmMemoryBytes: 1024 * 1024 * 1024,
  /** Shader invocations in one run: workgroups dispatched times the workgroup size. */
  gpuInvocations: 2 ** 24,
};

const WASM_PAGE = 64 * 1024;
/** What a device gives without asking for more. A larger @workgroup_size fails validation. */
const DEFAULT_MAX_WORKGROUP_INVOCATIONS = 256;

/**
 * The memories a module defines, in bytes. A module with no imports can only have memories from its
 * own memory section. max is null when the module declares none, so it could grow to the browser's
 * limit. Assumes a module that WebAssembly.compile already accepted.
 */
export function wasmMemories(bytes: Uint8Array): { initial: number; max: number | null }[] {
  let p = 8; // magic and version
  const byte = () => {
    if (p >= bytes.length) throw new Error("the module is cut short");
    return bytes[p++];
  };
  const leb = () => {
    let result = 0;
    let scale = 1;
    for (let i = 0; i < 10; i++) {
      const b = byte();
      result += (b & 0x7f) * scale;
      if (!(b & 0x80)) return result;
      scale *= 128;
    }
    throw new Error("bad number in the module");
  };
  while (p < bytes.length) {
    const id = byte();
    const size = leb();
    const end = p + size;
    if (id !== 5) {
      p = end;
      continue;
    }
    const memories: { initial: number; max: number | null }[] = [];
    for (let n = leb(); n > 0; n--) {
      const flags = byte();
      const initial = leb() * WASM_PAGE;
      memories.push({ initial, max: flags & 1 ? leb() * WASM_PAGE : null });
    }
    return memories;
  }
  return [];
}

/** Refuses a module that could take more memory than this browser should give one run. */
export function checkWasmMemory(bytes: Uint8Array) {
  const gib = LIMITS.wasmMemoryBytes / 1024 ** 3;
  for (const m of wasmMemories(bytes)) {
    if (m.initial > LIMITS.wasmMemoryBytes) throw new Error(`the module asks for more than ${gib} GiB of memory`);
    if (m.max === null) throw new Error(`the module's memory needs a maximum of at most ${gib} GiB`);
    if (m.max > LIMITS.wasmMemoryBytes) throw new Error(`the module's memory may grow past ${gib} GiB`);
  }
}

/** WGSL without its comments, which nest. WGSL has no string literals to take care of. */
function stripWgslComments(code: string) {
  let out = "";
  let depth = 0;
  for (let i = 0; i < code.length; i++) {
    const two = code.slice(i, i + 2);
    if (depth === 0 && two === "//") {
      while (i < code.length && code[i] !== "\n") i++;
      out += "\n";
    } else if (two === "/*") {
      depth++;
      i++;
    } else if (depth > 0 && two === "*/") {
      depth--;
      i++;
      out += " ";
    } else if (depth === 0) out += code[i];
  }
  return out;
}

/**
 * The largest workgroup in the shader, in invocations. A size that is not plain numbers (an override
 * or a constant) counts as the most a device allows, so this never comes out too low.
 */
export function workgroupInvocations(wgsl: string): number {
  let largest = 0;
  for (const m of stripWgslComments(wgsl).matchAll(/@\s*workgroup_size\s*\(([^)]*)\)/g)) {
    const dims = m[1].split(",").map((d) => d.trim()).filter(Boolean);
    const nums = dims.map((d) => (/^\d+[iu]?$/.test(d) ? parseInt(d, 10) : NaN));
    const size = nums.length >= 1 && nums.length <= 3 && nums.every((n) => n >= 1) ? nums.reduce((a, b) => a * b, 1) : DEFAULT_MAX_WORKGROUP_INVOCATIONS;
    largest = Math.max(largest, size);
  }
  return largest || DEFAULT_MAX_WORKGROUP_INVOCATIONS;
}

export const b64ToBytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export function bytesToB64(bytes: Uint8Array) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

export async function runWasm(req: { module: string; export?: string; args?: unknown[]; read?: { offset: number; length: number } }) {
  const bytes = b64ToBytes(req.module);
  if (bytes.length > LIMITS.moduleBytes) throw new Error("module too large");
  const module = await WebAssembly.compile(bytes);
  // The whole sandbox: a module that imports anything is refused, so it has no way out.
  if (WebAssembly.Module.imports(module).length > 0) throw new Error("the module must have no imports");
  // Read from the bytes the browser just accepted, before any memory is made for it.
  checkWasmMemory(bytes);
  const instance = await WebAssembly.instantiate(module, {});
  const name = req.export ?? "main";
  const fn = instance.exports[name];
  if (typeof fn !== "function") throw new Error(`no exported function "${name}"`);
  const args = req.args ?? [];
  if (!Array.isArray(args) || args.length > LIMITS.wasmArgs || !args.every((a) => typeof a === "number" && Number.isFinite(a))) {
    throw new Error("args must be a short list of numbers");
  }
  const started = performance.now();
  const value = (fn as (...a: number[]) => unknown)(...(args as number[]));
  const ms = performance.now() - started;
  const result: { value: string | number | null; ms: number; memory?: string } = {
    value: typeof value === "bigint" ? value.toString() : typeof value === "number" ? value : null,
    ms,
  };
  if (req.read) {
    const memory = instance.exports.memory;
    if (!(memory instanceof WebAssembly.Memory)) throw new Error("the module exports no memory to read");
    const { offset, length } = req.read;
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || length > LIMITS.readBytes || offset + length > memory.buffer.byteLength) {
      throw new Error("read is out of range");
    }
    result.memory = bytesToB64(new Uint8Array(memory.buffer, offset, length));
  }
  return result;
}

/**
 * One storage buffer at group 0, binding 0, entry point "main". The buffer starts with the input
 * and the renter gets the first outputBytes back.
 */
export async function runWebgpu(req: { wgsl: string; input?: string; outputBytes: number; dispatch: number[] }) {
  if (typeof req.wgsl !== "string" || req.wgsl.length > LIMITS.wgslChars) throw new Error("shader too large");
  const input = req.input ? b64ToBytes(req.input) : new Uint8Array(0);
  const outputBytes = req.outputBytes;
  if (!Number.isInteger(outputBytes) || outputBytes <= 0) throw new Error("output_bytes must be a positive integer");
  const size = Math.ceil(Math.max(input.length, outputBytes) / 4) * 4;
  if (size > LIMITS.gpuBufferBytes) throw new Error("buffer too large");
  const dispatch = req.dispatch;
  if (!Array.isArray(dispatch) || dispatch.length !== 3 || !dispatch.every((n) => Number.isInteger(n) && n >= 1 && n <= LIMITS.dispatchPerAxis)) {
    throw new Error("dispatch must be three integers from 1");
  }
  const invocations = dispatch[0] * dispatch[1] * dispatch[2] * workgroupInvocations(req.wgsl);
  if (invocations > LIMITS.gpuInvocations) throw new Error(`too much work for one run: at most ${LIMITS.gpuInvocations} invocations, dispatch times workgroup size`);
  const gpu = (navigator as any).gpu;
  const adapter = gpu && (await gpu.requestAdapter({ powerPreference: "high-performance" }));
  if (!adapter) throw new Error("this browser has no WebGPU");
  const device = await adapter.requestDevice();
  // A lost device (driver reset, GPU hang) ends the run with an error instead of a wait for the timeout.
  const lost = new Promise<never>((_, reject) =>
    device.lost.then((info: any) => reject(new Error(`the GPU device was lost: ${info?.message || info?.reason || "unknown"}`.slice(0, 300)))),
  );
  lost.catch(() => {}); // destroy() below also resolves device.lost
  try {
    return await Promise.race([lost, compute(device, req, input, size, outputBytes, dispatch)]);
  } finally {
    device.destroy();
  }
}

async function compute(device: any, req: { wgsl: string }, input: Uint8Array, size: number, outputBytes: number, dispatch: number[]) {
  device.pushErrorScope("validation");
  const shader = device.createShaderModule({ code: req.wgsl });
  const storage = device.createBuffer({
    size,
    usage: (globalThis as any).GPUBufferUsage.STORAGE | (globalThis as any).GPUBufferUsage.COPY_SRC | (globalThis as any).GPUBufferUsage.COPY_DST,
  });
  const readback = device.createBuffer({ size, usage: (globalThis as any).GPUBufferUsage.COPY_DST | (globalThis as any).GPUBufferUsage.MAP_READ });
  if (input.length) device.queue.writeBuffer(storage, 0, input);
  const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module: shader, entryPoint: "main" } });
  const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: storage } }] });
  const started = performance.now();
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bind);
  pass.dispatchWorkgroups(dispatch[0], dispatch[1], dispatch[2]);
  pass.end();
  encoder.copyBufferToBuffer(storage, 0, readback, 0, size);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(1 /* GPUMapMode.READ */);
  const ms = performance.now() - started;
  const output = new Uint8Array(readback.getMappedRange()).slice(0, outputBytes);
  readback.unmap();
  const error = await device.popErrorScope();
  if (error) throw new Error(`shader error: ${error.message}`.slice(0, 500));
  return { output: bytesToB64(output), ms };
}

self.onmessage = async (e: MessageEvent) => {
  const { wasm, webgpu } = e.data;
  try {
    const result = wasm ? await runWasm(wasm) : await runWebgpu(webgpu);
    self.postMessage({ ok: true, result });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err instanceof Error ? err.message : err).slice(0, 500) });
  }
};
