// CSV reader — WASM JSON-text-out transducer.
// AssemblyScript 0.27.36, --runtime stub, --enable simd,bulk-memory.
// Parses a UTF-16 input (code units) and emits the answer
// {"columns":...,"rows":[...],"errors":[...]} as UTF-8 JSON text.
// One parse() call per case; all state is reset at the top of parse().
// Memory layout (initial 128 MiB, max 256 MiB):
//   0 .. 64 MiB   input UTF-16 (JS copies it in)
//   64 MiB ..     output JSON text (UTF-8)
//   112 MiB       per-record field table (28 bytes per field)
//   120 MiB       error blob (variable-length records)
//   127 MiB       scratch (SIMD shuffle vector, int buffer)

// ---- layout constants ----
const OUT_PTR: i32 = 67108864;      // 64 MiB
const FIELD_TAB: i32 = 117440512;   // 112 MiB (8 MiB: ~300k fields/record)
const ERR_PTR0: i32 = 125829120;    // 120 MiB
const SCRATCH: i32 = 133169152;     // 127 MiB
const SWZ_PTR: i32 = 133169152;     // shuffle indices live at SCRATCH
const INT_SCR: i32 = 133169216;     // INT_SCR .. INT_SCR+16

// ---- field kinds (descriptor word 0 / word 3) ----
const K_NONE: i32 = 0;      // no second part
const K_RAW: i32 = 1;       // input span, verbatim
const K_RAW_DROP: i32 = 2;  // input span, drop lone CRs (stray CRs)
const K_QCLEAN: i32 = 3;    // quoted span, no escapes / no CR inside
const K_QCOOKED: i32 = 4;   // quoted span, "" -> " and CR/CRLF -> LF
const K_PREFIX: i32 = 5;    // unterminated re-read: leading '"' + span

// ---- error codes ----
const E_STRAY: i32 = 0;
const E_UNTERM: i32 = 1;
const E_JUNK: i32 = 2;
const E_SHORT: i32 = 3;
const E_LONG: i32 = 4;

// ---- field endings ----
const END_COMMA: i32 = 0;
const END_LB: i32 = 1;
const END_EOF: i32 = 2;

// ---- parser globals (all reset in parse()) ----
let gBase: i32;
let gEnd: i32;
let gPos: i32;
let gLine: i32;
let gWidth: i32;
let gHeader: i32;
let gColumnsNull: i32;
let gRowsOpen: i32;
let gRowsCount: i32;
let gOut: i32;
let gErrPtr: i32;
let gFieldCount: i32;
let gRecordLine: i32;
let gRecordRow: i32;
let gSpanNL: i32;   // quoted scan saw a CR or LF in the scanned chunks
let gSawEsc: i32;   // quoted scan saw a "" escape pair

// ---- current field descriptor (filled by the field parsers) ----
let gDk1: i32;
let gDs1: i32;
let gDl1: i32;
let gDk2: i32;
let gDs2: i32;
let gDl2: i32;
let gDaux: i32; // value length in code units (for the skip-empty rule)

// ---- SIMD splats (built once per parse()) ----
let SPL_COMMA: v128;
let SPL_LF: v128;
let SPL_CR: v128;
let SPL_QUOTE: v128;
let SPL_FF80: v128;
let SPL_20: v128;
let SPL_22: v128;
let SPL_5C: v128;
let SWZ: v128;

function unitAt(p: i32): i32 {
  return load<u16>(gBase + (p << 1));
}

function emitByte(b: i32): void {
  store<u8>(gOut, b);
  gOut++;
}

// Emit one code unit as JSON text (escaping + UTF-8). Lone surrogates
// become \uXXXX; surrogate pairs are handled by the caller (emitUnitAt).
function emitUnit(u: i32): void {
  if (u < 0x80) {
    if (u == 0x22) { emitByte(0x5C); emitByte(0x22); return; } // \"
    if (u == 0x5C) { emitByte(0x5C); emitByte(0x5C); return; } // \\
    if (u == 0x0A) { emitByte(0x5C); emitByte(0x6E); return; } // \n
    if (u == 0x0D) { emitByte(0x5C); emitByte(0x72); return; } // \r
    if (u == 0x09) { emitByte(0x5C); emitByte(0x74); return; } // \t
    if (u == 0x08) { emitByte(0x5C); emitByte(0x62); return; } // \b
    if (u == 0x0C) { emitByte(0x5C); emitByte(0x66); return; } // \f
    if (u < 0x20) { emitByte(0x5C); emitByte(0x75); emitByte(0x30); emitByte(0x30); emitHex2(u); return; } // \u00xx
    emitByte(u);
    return;
  }
  if (u >= 0xD800 && u <= 0xDFFF) { emitUnicodeEscape(u); return; } // lone surrogate
  if (u < 0x800) {
    emitByte(0xC0 | (u >> 6));
    emitByte(0x80 | (u & 0x3F));
    return;
  }
  emitByte(0xE0 | (u >> 12));
  emitByte(0x80 | ((u >> 6) & 0x3F));
  emitByte(0x80 | (u & 0x3F));
}

function emitHexDigit(d: i32): void {
  if (d < 10) emitByte(48 + d); else emitByte(87 + d);
}

function emitHex2(u: i32): void {
  emitHexDigit((u >> 4) & 15);
  emitHexDigit(u & 15);
}

function emitUnicodeEscape(u: i32): void {
  emitByte(0x5C); // \
  emitByte(0x75); // u
  emitHexDigit((u >> 12) & 15);
  emitHexDigit((u >> 8) & 15);
  emitHexDigit((u >> 4) & 15);
  emitHexDigit(u & 15);
}

// Emit the unit at p (handling a surrogate pair with p+1); return next p.
function emitUnitAt(p: i32, end: i32): i32 {
  let u = unitAt(p);
  if (u >= 0xD800 && u <= 0xDBFF && p + 1 < end) {
    let u2 = unitAt(p + 1);
    if (u2 >= 0xDC00 && u2 <= 0xDFFF) {
      let cp = 0x10000 + ((u - 0xD800) << 10) + (u2 - 0xDC00);
      emitByte(0xF0 | (cp >> 18));
      emitByte(0x80 | ((cp >> 12) & 0x3F));
      emitByte(0x80 | ((cp >> 6) & 0x3F));
      emitByte(0x80 | (cp & 0x3F));
      return p + 2;
    }
  }
  emitUnit(u);
  return p + 1;
}

function emitInt(n: i32): void {
  if (n == 0) { emitByte(48); return; }
  let p = INT_SCR + 16;
  let x = n;
  while (x > 0) {
    p--;
    store<u8>(p, 48 + (x % 10));
    x = x / 10;
  }
  while (p < INT_SCR + 16) {
    emitByte(load<u8>(p));
    p++;
  }
}

// ---- span emitters (field value parts) ----

// True when all 8 lanes of the chunk are printable ASCII other than
// '"' and '\'. A chunk past the span end may read the next field's
// units; that can only turn a bulk step into a scalar one, never a
// wrong store (a true result means every lane is clean).
function chunkClean(v: v128): bool {
  let m = v128.or(
    v128.or(v128.and(v, SPL_FF80), i16x8.lt_u(v, SPL_20)),
    v128.or(i16x8.eq(v, SPL_22), i16x8.eq(v, SPL_5C))
  );
  return !v128.any_true(m);
}

// Scalar emission with the ASCII case inlined: one load, a few
// branches, one store per plain unit. Only escapes and non-ASCII go
// through the (rare) emitUnit / emitUnitAt calls.
function emitScalarFast(p: i32, end: i32): i32 {
  while (p < end) {
    let u = unitAt(p);
    if (u < 0x80) {
      if (u == 0x22 || u == 0x5C || u < 0x20) emitUnit(u);
      else { store<u8>(gOut, u); gOut++; }
      p++;
    } else {
      p = emitUnitAt(p, end);
    }
  }
  return p;
}

// Bulk ASCII path: 8, then 4, then 2 units at a time (one swizzle and
// store per step; the store writes a full 16-byte vector and gOut
// advances by the step, so the bytes past the step are scratch that
// the next write overwrites). At most one unit is left for the scalar
// tail, so short fields no longer pay a per-character call chain.
function emitSpan(start: i32, len: i32): void {
  let p = start;
  let end = start + len;
  while (p + 8 <= end) {
    let v = v128.load(gBase + (p << 1));
    if (chunkClean(v)) {
      v128.store(gOut, v128.swizzle(v, SWZ));
      gOut += 8;
      p += 8;
    } else {
      p = emitScalarFast(p, p + 8);
    }
  }
  if (p + 4 <= end) {
    let v = v128.load(gBase + (p << 1));
    if (chunkClean(v)) {
      v128.store(gOut, v128.swizzle(v, SWZ));
      gOut += 4;
      p += 4;
    } else {
      p = emitScalarFast(p, p + 4);
    }
  }
  if (p + 2 <= end) {
    let v = v128.load(gBase + (p << 1));
    if (chunkClean(v)) {
      v128.store(gOut, v128.swizzle(v, SWZ));
      gOut += 2;
      p += 2;
    } else {
      p = emitScalarFast(p, p + 2);
    }
  }
  emitScalarFast(p, end);
}

// Unquoted span that contained stray CRs: same as emitSpan but lone
// CR units are dropped. Rare path, scalar only, ASCII case inlined.
function emitSpanDropCR(start: i32, len: i32): void {
  let p = start;
  let end = start + len;
  while (p < end) {
    let u = unitAt(p);
    if (u == 0x0D) { p++; continue; }
    if (u < 0x80) {
      if (u == 0x22 || u == 0x5C || u < 0x20) emitUnit(u);
      else { store<u8>(gOut, u); gOut++; }
      p++;
    } else {
      p = emitUnitAt(p, end);
    }
  }
}

// Quoted span needing unescaping: "" -> " and CR / CRLF -> LF.
function emitSpanCooked(start: i32, len: i32): void {
  let p = start;
  let end = start + len;
  while (p < end) {
    let u = unitAt(p);
    if (u == 0x22) {
      // A '"' inside a quoted span is always half of a "" pair.
      emitByte(0x5C); emitByte(0x22);
      p += 2;
      continue;
    }
    if (u == 0x0D) {
      emitUnit(0x0A); // CR or CRLF both become one LF
      if (p + 1 < end && unitAt(p + 1) == 0x0A) p += 2; else p += 1;
      continue;
    }
    if (u < 0x80) {
      if (u == 0x5C || u < 0x20) emitUnit(u);
      else { store<u8>(gOut, u); gOut++; }
      p++;
    } else {
      p = emitUnitAt(p, end);
    }
  }
}

function emitPart(kind: i32, start: i32, len: i32): void {
  if (kind == K_RAW) emitSpan(start, len);
  else if (kind == K_RAW_DROP) emitSpanDropCR(start, len);
  else if (kind == K_QCLEAN) emitSpan(start, len);
  else if (kind == K_QCOOKED) emitSpanCooked(start, len);
  else if (kind == K_PREFIX) { emitUnit(0x22); emitSpanDropCR(start, len); }
}

// Emit one field from the table as a JSON string.
function emitFieldAt(base: i32): void {
  emitByte(0x22);
  emitPart(load<i32>(base), load<i32>(base + 4), load<i32>(base + 8));
  let k2 = load<i32>(base + 12);
  if (k2 != K_NONE) emitPart(k2, load<i32>(base + 16), load<i32>(base + 20));
  emitByte(0x22);
}

function storeField(fd: i32): void {
  let base = FIELD_TAB + fd * 28;
  store<i32>(base, gDk1);
  store<i32>(base + 4, gDs1);
  store<i32>(base + 8, gDl1);
  store<i32>(base + 12, gDk2);
  store<i32>(base + 16, gDs2);
  store<i32>(base + 20, gDl2);
  store<i32>(base + 24, gDaux);
}

function setDesc(k1: i32, s1: i32, l1: i32, k2: i32, s2: i32, l2: i32, aux: i32): void {
  gDk1 = k1; gDs1 = s1; gDl1 = l1;
  gDk2 = k2; gDs2 = s2; gDl2 = l2;
  gDaux = aux;
}

// ---- SIMD scans ----

// Index of the next ',' / LF / CR at or after pos, or -1.
function findDelim(pos: i32, end: i32): i32 {
  let p = pos;
  while (p + 8 <= end) {
    let v = v128.load(gBase + (p << 1));
    let m = v128.or(
      v128.or(i16x8.eq(v, SPL_COMMA), i16x8.eq(v, SPL_LF)),
      i16x8.eq(v, SPL_CR)
    );
    let bits = i16x8.bitmask(m);
    if (bits != 0) return p + i32.ctz(bits);
    p += 8;
  }
  while (p < end) {
    let u = unitAt(p);
    if (u == 44 || u == 10 || u == 13) return p;
    p++;
  }
  return -1;
}

// Index of the closing '"' at or after start, or -1 when the quote
// never closes. Skips "" escape pairs (sets gSawEsc). Sets gSpanNL
// when any CR or LF is seen in a scanned chunk (false positives from
// lanes past the closing quote are harmless: the line count below
// only ever walks the confirmed span).
function scanQuoted(start: i32, end: i32): i32 {
  gSpanNL = 0;
  gSawEsc = 0;
  let p = start;
  while (p < end) {
    if (p + 8 <= end) {
      let v = v128.load(gBase + (p << 1));
      let bits = i16x8.bitmask(i16x8.eq(v, SPL_QUOTE));
      if (v128.any_true(v128.or(i16x8.eq(v, SPL_LF), i16x8.eq(v, SPL_CR)))) gSpanNL = 1;
      if (bits != 0) {
        let q = p + i32.ctz(bits);
        if (q + 1 < end && unitAt(q + 1) == 34) { gSawEsc = 1; p = q + 2; continue; }
        return q;
      }
      p += 8;
    } else {
      let u = unitAt(p);
      if (u == 10 || u == 13) gSpanNL = 1;
      if (u == 34) {
        if (p + 1 < end && unitAt(p + 1) == 34) { gSawEsc = 1; p += 2; continue; }
        return p;
      }
      p++;
    }
  }
  return -1;
}

// ---- error blob ----
// Each record: code, line, row, aux (16 bytes). A long_row record is
// followed by aux field descriptors (28 bytes each) copied from the
// per-record field table, so the extra fields survive past the record.
function pushErr(code: i32, line: i32, row: i32, aux: i32): void {
  store<i32>(gErrPtr, code);
  store<i32>(gErrPtr + 4, line);
  store<i32>(gErrPtr + 8, row);
  store<i32>(gErrPtr + 12, aux);
  gErrPtr += 16;
}

function pushLongErr(line: i32, row: i32, count: i32): void {
  pushErr(E_LONG, line, row, count);
  let src = FIELD_TAB + gWidth * 28;
  for (let i = 0; i < count; i++) {
    for (let w = 0; w < 7; w++) store<i32>(gErrPtr + w * 4, load<i32>(src + w * 4));
    src += 28;
    gErrPtr += 28;
  }
}

// ---- field parsers ----
// Both fill the gD* descriptor globals and return the ending
// (END_COMMA / END_LB / END_EOF). They advance gPos / gLine.

// Unquoted field starting at `start` (== gPos on entry). With isPrefix
// the value starts with a literal '"' (unterminated re-read).
function parseUnquoted(start: i32, isPrefix: i32): i32 {
  let p = gPos;
  let stray = 0;
  let spanEnd = p;
  let ending = END_EOF;
  while (true) {
    let d = findDelim(p, gEnd);
    if (d < 0) { spanEnd = gEnd; gPos = gEnd; ending = END_EOF; break; }
    let u = unitAt(d);
    if (u == 44) { spanEnd = d; gPos = d + 1; ending = END_COMMA; break; }
    if (u == 10) { spanEnd = d; gPos = d + 1; gLine++; ending = END_LB; break; }
    // CR: CRLF ends the field, a lone CR is a stray (dropped, error kept).
    if (d + 1 < gEnd && unitAt(d + 1) == 10) { spanEnd = d; gPos = d + 2; gLine++; ending = END_LB; break; }
    pushErr(E_STRAY, gRecordLine, gRecordRow, 0);
    stray++;
    p = d + 1;
  }
  let spanLen = spanEnd - start;
  if (isPrefix != 0) setDesc(K_PREFIX, start, spanLen, K_NONE, 0, 0, spanLen - stray + 1);
  else if (stray > 0) setDesc(K_RAW_DROP, start, spanLen, K_NONE, 0, 0, spanLen - stray);
  else setDesc(K_RAW, start, spanLen, K_NONE, 0, 0, spanLen);
  return ending;
}

// Quoted field: gPos points at the opening '"'.
function parseQuoted(): i32 {
  let open = gPos;
  let openLine = gLine;
  gPos++;
  let q = scanQuoted(gPos, gEnd);
  if (q < 0) {
    // Unterminated: rewind (the failed scan must not have moved the
    // line), push the error, re-read as unquoted with a '"' prefix.
    gPos = open + 1;
    gLine = openLine;
    pushErr(E_UNTERM, gRecordLine, gRecordRow, 0);
    return parseUnquoted(open + 1, 1);
  }
  let cooked = gSawEsc;
  if (gSpanNL != 0) {
    // Count the lines inside the confirmed span, in bulk, and learn
    // whether any CR is in there (CR forces the cooked path).
    let cnt = 0;
    let hasCR = 0;
    let spanStart = open + 1;
    for (let i = spanStart; i < q; i++) {
      let u = unitAt(i);
      if (u == 10) cnt++;
      else if (u == 13) {
        hasCR = 1;
        if (i + 1 >= q || unitAt(i + 1) != 10) cnt++;
      }
    }
    gLine += cnt;
    if (hasCR != 0) cooked = 1;
  }
  let spanStart = open + 1;
  let spanLen = q - spanStart;
  let k1 = cooked != 0 ? K_QCOOKED : K_QCLEAN;
  gPos = q + 1;
  if (gPos >= gEnd) { setDesc(k1, spanStart, spanLen, K_NONE, 0, 0, 1); return END_EOF; }
  let u = unitAt(gPos);
  if (u == 44) { gPos++; setDesc(k1, spanStart, spanLen, K_NONE, 0, 0, 1); return END_COMMA; }
  if (u == 10) { gPos++; gLine++; setDesc(k1, spanStart, spanLen, K_NONE, 0, 0, 1); return END_LB; }
  if (u == 13 && gPos + 1 < gEnd && unitAt(gPos + 1) == 10) {
    gPos += 2; gLine++; setDesc(k1, spanStart, spanLen, K_NONE, 0, 0, 1); return END_LB;
  }
  // Junk after the closing quote: an unquoted read whose value is
  // appended to the quoted value. Its stray_cr errors (if any) are
  // pushed by the read itself, before the quote_junk error below.
  let junkStart = gPos;
  let ending = parseUnquoted(junkStart, 0);
  let junkAdded = gDaux;
  let jk = gDk1;
  let js = gDs1;
  let jl = gDl1;
  setDesc(k1, spanStart, spanLen, jk, js, jl, 1);
  if (junkAdded > 0) pushErr(E_JUNK, gRecordLine, gRecordRow, 0);
  return ending;
}

// ---- output helpers ----

// Emit the field table as a JSON array: fields [0, count).
function emitFieldArray(count: i32): void {
  emitByte(0x5B); // [
  for (let i = 0; i < count; i++) {
    if (i > 0) emitByte(0x2C); // ,
    emitFieldAt(FIELD_TAB + i * 28);
  }
  emitByte(0x5D); // ]
}

// Emit one row: the first `count` fields, padded with "" to width.
function emitRow(count: i32): void {
  if (gRowsOpen == 0) {
    emitByte(0x2C); // ,
    emitByte(0x22); emitByte(0x72); emitByte(0x6F); emitByte(0x77); emitByte(0x73); emitByte(0x22); // "rows"
    emitByte(0x3A); emitByte(0x5B); // :[
    gRowsOpen = 1;
  } else {
    emitByte(0x2C); // ,
  }
  emitByte(0x5B); // [
  let n = count < gWidth ? count : gWidth;
  for (let i = 0; i < n; i++) {
    if (i > 0) emitByte(0x2C);
    emitFieldAt(FIELD_TAB + i * 28);
  }
  for (let i = count; i < gWidth; i++) {
    if (i > 0) emitByte(0x2C);
    emitByte(0x22); emitByte(0x22); // ""
  }
  emitByte(0x5D); // ]
}

// Emit the error blob as JSON objects.
function emitErrors(): void {
  emitByte(0x2C); // ,
  emitByte(0x22); emitByte(0x65); emitByte(0x72); emitByte(0x72); emitByte(0x6F); emitByte(0x72); emitByte(0x73); emitByte(0x22); // "errors"
  emitByte(0x3A); emitByte(0x5B); // :[
  let ptr = ERR_PTR0;
  let first = 1;
  while (ptr < gErrPtr) {
    let code = load<i32>(ptr);
    let line = load<i32>(ptr + 4);
    let row = load<i32>(ptr + 8);
    let aux = load<i32>(ptr + 12);
    ptr += 16;
    if (first == 0) emitByte(0x2C); else first = 0;
    emitByte(0x7B); // {
    emitByte(0x22); emitByte(0x63); emitByte(0x6F); emitByte(0x64); emitByte(0x65); emitByte(0x22); emitByte(0x3A); emitByte(0x22); // "code":"
    if (code == E_STRAY) { emitByte(0x73); emitByte(0x74); emitByte(0x72); emitByte(0x61); emitByte(0x79); emitByte(0x5F); emitByte(0x63); emitByte(0x72); } // stray_cr
    else if (code == E_UNTERM) { emitByte(0x75); emitByte(0x6E); emitByte(0x74); emitByte(0x65); emitByte(0x72); emitByte(0x6D); emitByte(0x69); emitByte(0x6E); emitByte(0x61); emitByte(0x74); emitByte(0x65); emitByte(0x64); emitByte(0x5F); emitByte(0x71); emitByte(0x75); emitByte(0x6F); emitByte(0x74); emitByte(0x65); } // unterminated_quote
    else if (code == E_JUNK) { emitByte(0x71); emitByte(0x75); emitByte(0x6F); emitByte(0x74); emitByte(0x65); emitByte(0x5F); emitByte(0x6A); emitByte(0x75); emitByte(0x6E); emitByte(0x6B); } // quote_junk
    else if (code == E_SHORT) { emitByte(0x73); emitByte(0x68); emitByte(0x6F); emitByte(0x72); emitByte(0x74); emitByte(0x5F); emitByte(0x72); emitByte(0x6F); emitByte(0x77); } // short_row
    else { emitByte(0x6C); emitByte(0x6F); emitByte(0x6E); emitByte(0x67); emitByte(0x5F); emitByte(0x72); emitByte(0x6F); emitByte(0x77); } // long_row
    emitByte(0x22); // "
    emitByte(0x2C); // ,
    emitByte(0x22); emitByte(0x6C); emitByte(0x69); emitByte(0x6E); emitByte(0x65); emitByte(0x22); emitByte(0x3A); // "line":
    emitInt(line);
    emitByte(0x2C); // ,
    emitByte(0x22); emitByte(0x72); emitByte(0x6F); emitByte(0x77); emitByte(0x22); emitByte(0x3A); // "row":
    if (row < 0) { emitByte(0x6E); emitByte(0x75); emitByte(0x6C); emitByte(0x6C); } // null
    else emitInt(row);
    if (code == E_SHORT) {
      emitByte(0x2C);
      emitByte(0x22); emitByte(0x66); emitByte(0x69); emitByte(0x65); emitByte(0x6C); emitByte(0x64); emitByte(0x73); emitByte(0x22); emitByte(0x3A); // "fields":
      emitInt(aux);
    } else if (code == E_LONG) {
      emitByte(0x2C);
      emitByte(0x22); emitByte(0x65); emitByte(0x78); emitByte(0x74); emitByte(0x72); emitByte(0x61); emitByte(0x22); emitByte(0x3A); // "extra":
      emitByte(0x5B); // [
      for (let i = 0; i < aux; i++) {
        if (i > 0) emitByte(0x2C);
        emitFieldAt(ptr + i * 28);
      }
      emitByte(0x5D); // ]
      ptr += aux * 28;
    }
    emitByte(0x7D); // }
  }
  emitByte(0x5D); // ]
}

// ---- entry point ----
// inPtr: byte offset of the UTF-16 input in linear memory (JS passes 0).
// inLen: input length in UTF-16 code units. header: 1 when header === true.
// Returns the output JSON byte length; the text sits at OUT_PTR.
export function parse(inPtr: i32, inLen: i32, header: i32): i32 {
  gBase = inPtr;
  gEnd = inLen;
  gPos = 0;
  gLine = 1;
  gWidth = -1;
  gHeader = header;
  gColumnsNull = 1;
  gRowsOpen = 0;
  gRowsCount = 0;
  gOut = OUT_PTR;
  gErrPtr = ERR_PTR0;
  gFieldCount = 0;
  gRecordLine = 1;
  gRecordRow = 0;
  gSpanNL = 0;
  gSawEsc = 0;

  SPL_COMMA = i16x8.splat(44);
  SPL_LF = i16x8.splat(10);
  SPL_CR = i16x8.splat(13);
  SPL_QUOTE = i16x8.splat(34);
  SPL_FF80 = i16x8.splat(-128); // 0xFF80 as i16: catches any unit >= 0x80
  SPL_20 = i16x8.splat(0x20);
  SPL_22 = i16x8.splat(0x22);
  SPL_5C = i16x8.splat(0x5C);
  // Shuffle indices: low byte of each of the 8 units, then padding.
  for (let i = 0; i < 8; i++) store<u8>(SWZ_PTR + i, i * 2);
  for (let i = 8; i < 16; i++) store<u8>(SWZ_PTR + i, 0);
  SWZ = v128.load(SWZ_PTR);

  // A U+FEFF at the very start is dropped (line stays 1).
  if (inLen > 0 && load<u16>(inPtr) == 0xFEFF) gPos = 1;

  // {"columns":
  emitByte(0x7B); // {
  emitByte(0x22); emitByte(0x63); emitByte(0x6F); emitByte(0x6C); emitByte(0x75); emitByte(0x6D); emitByte(0x6E); emitByte(0x73); emitByte(0x22); // "columns"
  emitByte(0x3A); // :
  if (header == 0) {
    emitByte(0x6E); emitByte(0x75); emitByte(0x6C); emitByte(0x6C); // null
    gColumnsNull = 0;
  }

  while (true) {
    // Skip empty lines: LF, or CRLF. A lone CR is NOT skipped here.
    while (gPos < gEnd) {
      let u = unitAt(gPos);
      if (u == 10) { gPos++; gLine++; }
      else if (u == 13 && gPos + 1 < gEnd && unitAt(gPos + 1) == 10) { gPos += 2; gLine++; }
      else break;
    }
    if (gPos >= gEnd) break;

    gRecordLine = gLine;
    gRecordRow = (header != 0 && gColumnsNull != 0) ? -1 : gRowsCount;

    // Parse the record's fields into the table.
    gFieldCount = 0;
    let ending = END_EOF;
    while (true) {
      if (unitAt(gPos) == 34) ending = parseQuoted();
      else ending = parseUnquoted(gPos, 0);
      storeField(gFieldCount);
      gFieldCount++;
      if (ending == END_COMMA) continue;
      break;
    }

    // One unquoted empty field is not a record at all (errors stay).
    if (gFieldCount == 1) {
      let k1 = load<i32>(FIELD_TAB);
      let aux = load<i32>(FIELD_TAB + 24);
      if ((k1 == K_RAW || k1 == K_RAW_DROP) && aux == 0) continue;
    }

    if (gWidth < 0) gWidth = gFieldCount;

    if (header != 0 && gColumnsNull != 0) {
      // First record is the header: columns, never short/long checked.
      emitFieldArray(gFieldCount);
      gColumnsNull = 0;
    } else {
      if (gFieldCount < gWidth) pushErr(E_SHORT, gRecordLine, gRecordRow, gFieldCount);
      else if (gFieldCount > gWidth) pushLongErr(gRecordLine, gRecordRow, gFieldCount - gWidth);
      emitRow(gFieldCount);
      gRowsCount++;
    }
  }

  // No records at all: header true means columns [].
  if (gColumnsNull != 0) { emitByte(0x5B); emitByte(0x5D); } // []
  if (gRowsOpen == 0) {
    emitByte(0x2C); // ,
    emitByte(0x22); emitByte(0x72); emitByte(0x6F); emitByte(0x77); emitByte(0x73); emitByte(0x22); // "rows"
    emitByte(0x3A); emitByte(0x5B); emitByte(0x5D); // :[]
  } else {
    emitByte(0x5D); // ]
  }
  emitErrors();
  emitByte(0x7D); // }
  return gOut - OUT_PTR;
}
