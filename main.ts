// Driver v4 — byte-path: cases.json is read as a raw Buffer and walked
// structurally (no whole-file utf8 decode, no whole-file JSON.parse).
// Each case's `text` string is decoded by the native JSON parser applied
// to that one string token only, and each answer is serialised per row
// with the native JSON.stringify and streamed out per case (no
// whole-answers JSON.stringify, no 12 MB intermediate string).
// V8 incremental marking is switched off before solve.js is imported so
// the timed run is not perturbed by background GC marking.
import { setFlagsFromString } from 'node:v8';
setFlagsFromString('--no-incremental-marking');
import { readFileSync, openSync, writeSync, closeSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const { run } = await import('./solve.js');

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const buf = readFileSync(join(inputDir, 'cases.json'));
const n = buf.length;
let p = 0;

// --- minimal structural JSON walk over the raw bytes --------------------
// Only the shape is walked: object keys are matched to their own values,
// so a `"text"` byte sequence inside a string value can never be mistaken
// for a key. A string token's end is found by scanning for the next
// unescaped `"` (a `"` preceded by an odd run of `\` is escaped); the
// token (quotes included) is then decoded with the native JSON parser.
// That keeps the decode in native code and builds no object graph.
function skipWS() {
  while (p < n) {
    const c = buf[p];
    if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) p++;
    else break;
  }
}

// Index of the closing quote of the JSON string starting at p
// (buf[p] === '"'). The caller guarantees the input is valid JSON.
function stringEnd() {
  let i = buf.indexOf(0x22, p + 1);
  for (;;) {
    let j = i - 1;
    let c = 0;
    while (buf[j] === 0x5c) { c++; j--; }
    if (c % 2 === 0) return i;
    i = buf.indexOf(0x22, i + 1);
  }
}

// Decode the JSON string at p (buf[p] === '"'); advances p past it.
function parseString() {
  const e = stringEnd();
  const s = JSON.parse(buf.toString('utf8', p, e + 1));
  p = e + 1;
  return s;
}

// Parse one JSON value starting at p. Objects/arrays fill `cur` with any
// `text` / `header` members found at any depth and return null; a string
// or primitive value is returned decoded. `cur` is the case being built.
function parseValue(cur) {
  skipWS();
  const c = buf[p];
  if (c === 0x22) return parseString();
  if (c === 0x7b) { // '{'
    p++;
    skipWS();
    if (buf[p] === 0x7d) { p++; return null; }
    for (;;) {
      skipWS();
      const key = parseString();
      skipWS();
      p++; // ':'
      const v = parseValue(cur);
      if (key === 'text' && v !== null && typeof v !== 'object') cur.text = v;
      else if (key === 'header') cur.header = v === true;
      skipWS();
      if (buf[p] === 0x2c) { p++; continue; }
      p++; // '}'
      return null;
    }
  }
  if (c === 0x5b) { // '['
    p++;
    skipWS();
    if (buf[p] === 0x5d) { p++; return null; }
    for (;;) {
      parseValue(cur);
      skipWS();
      if (buf[p] === 0x2c) { p++; continue; }
      p++; // ']'
      return null;
    }
  }
  if (c === 0x74) { p += 4; return true; } // true
  if (c === 0x66) { p += 5; return false; } // false
  if (c === 0x6e) { p += 4; return null; } // null
  // number: scan [0-9eE+-.] (values are never needed, only skipped)
  while (p < n) {
    const d = buf[p];
    if ((d >= 0x30 && d <= 0x39) || d === 0x2e || d === 0x65 || d === 0x45 || d === 0x2b || d === 0x2d) p++;
    else break;
  }
  return 0;
}

// --- per-case answer serialisation ---------------------------------------
// Rows are serialised one row at a time with the native JSON.stringify.
// Measured on the practice set: ~95 ms total, vs ~220 ms for a hand
// rolled per-string escape check — and the native path escapes every
// string exactly as JSON.stringify would (quotes, backslashes, control
// characters, lone surrogates). Output verified byte-identical to
// JSON.stringify of the whole answers array. Columns/errors are small
// enough to stringify whole. No whole-answers string is ever built.
function serializeAnswer(a) {
  const parts = ['{"columns":', a.columns === null ? 'null' : JSON.stringify(a.columns), ',"rows":['];
  const rows = a.rows;
  for (let r = 0; r < rows.length; r++) {
    if (r) parts.push(',');
    parts.push(JSON.stringify(rows[r]));
  }
  parts.push('],"errors":', JSON.stringify(a.errors), '}');
  return parts.join('');
}

// --- main loop: one case at a time, streamed straight to disk ------------
mkdirSync(outputDir, { recursive: true });
const fd = openSync(join(outputDir, 'answers.json'), 'w');
skipWS();
p++; // '['
skipWS();
writeSync(fd, '[');
if (buf[p] !== 0x5d) { // not an empty array
  let first = true;
  for (;;) {
    const cur = { text: undefined, header: false };
    parseValue(cur);
    const ans = run({ text: cur.text, header: cur.header });
    writeSync(fd, (first ? '' : ',') + serializeAnswer(ans));
    first = false;
    skipWS();
    if (buf[p] === 0x2c) { p++; continue; }
    break; // must be ']'
  }
}
writeSync(fd, ']');
closeSync(fd);
