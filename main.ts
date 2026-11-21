// Driver the harness runs: node /bot/main.ts (Node 22).
// Reads every case from /input/cases.json, answers each one alone with
// run() from solve.js, writes /output/answers.json as a JSON array.
// The answers are JSON text already, so they are concatenated directly:
// no JSON.parse of any answer and no JSON.stringify of the array.
// Plain JavaScript in a .ts file: no TypeScript-only syntax, so Node's
// type stripping runs it as-is.
import { setFlagsFromString } from 'node:v8';
import { readFileSync, mkdirSync, openSync, writeSync, closeSync } from 'node:fs';

setFlagsFromString('--no-incremental-marking');

// solve.js is imported only after the V8 flag above is set.
const { runBytes } = await import('./solve.js');

const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';
const cases = JSON.parse(readFileSync(inputDir + '/cases.json', 'utf8'));

// The answers are JSON text already, so they are written straight to
// the file as bytes, one case at a time: no JSON.parse of any answer,
// no JSON.stringify of the array, and no 12 MB joined string.
// runBytes returns a byte range in WASM memory, valid until the next
// case is parsed, so each case is written before the next one runs.
mkdirSync(outputDir, { recursive: true });
const fd = openSync(outputDir + '/answers.json', 'w');
writeSync(fd, '[');
for (let i = 0; i < cases.length; i++) {
  if (i > 0) writeSync(fd, ',');
  const range = runBytes(cases[i].input);
  writeSync(fd, new Uint8Array(range.buffer, range.byteOffset, range.byteLength));
}
writeSync(fd, ']');
closeSync(fd);
