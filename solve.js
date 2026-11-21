// CSV reader entry point: a thin ES module around the WASM transducer.
// The WASM module is compiled and instantiated ONCE at import time and
// reused for every case. run() is deterministic and keeps no state
// between calls: all parser state lives in WASM and is reset per parse().
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const wasmBytes = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'reader.wasm'));
const wasmInstance = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), {});
const wasmMemory = wasmInstance.exports.memory;
const wasmParse = wasmInstance.exports.parse;
const OUT_PTR = 67108864; // 64 MiB: must match assembly/index.ts
const utf8Decoder = new TextDecoder('utf-8');

// run(input) -> the JSON text of {columns, rows, errors} for this case.
// The input text is copied into WASM memory as UTF-16 code units with a
// single native Buffer conversion; the answer comes back as UTF-8 JSON
// text decoded once. No JSON.parse / JSON.stringify anywhere in here.
export function run(input) {
  const text = String(input.text);
  const header = input.header === true ? 1 : 0;
  const bytes = Buffer.from(text, 'utf16le');
  const mem = new Uint8Array(wasmMemory.buffer);
  mem.set(bytes, 0);
  const outLen = wasmParse(0, text.length, header);
  return utf8Decoder.decode(mem.subarray(OUT_PTR, OUT_PTR + outLen));
}

// runBytes(input) -> the answer as a raw UTF-8 byte range in WASM memory
// ({buffer, byteOffset, byteLength}), for main.ts to write straight to
// the output file without decoding to a JS string and joining. The bytes
// are only valid until the next run* call on this instance.
export function runBytes(input) {
  const text = String(input.text);
  const header = input.header === true ? 1 : 0;
  const bytes = Buffer.from(text, 'utf16le');
  const mem = new Uint8Array(wasmMemory.buffer);
  mem.set(bytes, 0);
  const outLen = wasmParse(0, text.length, header);
  return { buffer: wasmMemory.buffer, byteOffset: OUT_PTR, byteLength: outLen };
}
