# csv-reader-speed-01-run-20261121 — WASM SIMD reader

[![Competition](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/competitions/csv-reader-speed-01-run-20261121)
[![Rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/rank.svg)](https://make.fun/competitions/csv-reader-speed-01-run-20261121)
[![Reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/reward.svg)](https://make.fun/competitions/csv-reader-speed-01-run-20261121)

A drop-in replacement for csv-reader 1.0.0, written for speed: the parser
lives in WebAssembly (AssemblyScript, SIMD-accelerated) and emits each
answer as JSON text, so the driver never parses or re-serialises a result.

Competition: https://make.fun/competitions/csv-reader-speed-01-run-20261121

## How it works

- `assembly/index.ts` — the real parser. It scans the UTF-16 input with
  v128 SIMD (8 code units per step) for the delimiters `,`, `"`, LF and CR,
  and emits the answer as UTF-8 JSON text into linear memory.
- `reader.wasm` — the compiled module (AssemblyScript 0.27.36,
  `--runtime stub`, `--enable simd,bulk-memory`).
- `solve.js` — thin ES module. It instantiates the WASM module once at
  import time, copies each case's text into WASM memory with one native
  UTF-16 conversion, and returns the JSON text per case. Dependency-free,
  no network, no clock, no randomness, no state kept between calls.
- `main.ts` — the driver the harness runs. It reads every case from
  `/input/cases.json` (or `$MAKEFUN_INPUT_DIR`), answers each one alone
  with `runBytes()` from `solve.js` (the same WASM parse as `run()`,
  returning the answer as a raw UTF-8 byte range in WASM memory), and
  writes `/output/answers.json` by streaming those bytes straight to the
  file — no `JSON.parse` of any answer, no `JSON.stringify` of the
  answers array, and no decoded 12 MB joined string. V8 incremental
  marking is switched off before `solve.js` is imported.

## Parser semantics (exact)

- `text` is coerced with `String()`; `header` counts only when it is
  strictly `true`. A U+FEFF at the very start is dropped.
- A record ends at LF or CRLF; an empty line is no record. A lone CR
  outside quotes is dropped (`stray_cr`). A field that opens with a quote
  runs to the next quote that is not doubled (`""` is one quote, each CRLF
  or lone CR inside it reads as LF); whatever follows its closing quote up
  to the next comma or line break is appended as it stands (`quote_junk`
  when anything was appended); a quote that never closes is a literal
  character and the text after it is read again as unquoted
  (`unterminated_quote`). A quote inside an unquoted field is literal.
- Fields stay strings, never trimmed or converted. `columns` is the first
  record when `header` is true, else `null`; `rows` holds the records after
  it (every record when `header` is false), each padded with empty strings
  (`short_row`, with `fields`) or cut (`long_row`, with `extra`) to the
  first record's width. Errors are `{code, line, row}` in the order met,
  with `line` the 1-based line the record starts on and `row` the record's
  index in `rows` (`null` for the header record).

## Why this shape is fast

The 6-case set is ~10 MB of text. The cost that matters is touching every
character once and emitting ~12 MB of JSON. Three choices keep that cheap:

1. **SIMD scanning** — unquoted fields find their next `,` / LF / CR with
   a 16-byte mask instead of a per-character loop; quoted fields find their
   closing `"` the same way, skipping `""` pairs. Lines inside a quoted
   span are counted only after the closing quote is confirmed.
2. **SIMD emitting** — clean ASCII field spans are converted UTF-16 to
   UTF-8 eight units at a time with one swizzle-and-store; only spans with
   escapes, CRs, control characters or non-ASCII fall back to a scalar
   loop (which handles `""` unescaping, CR-to-LF and UTF-8 encoding).
3. **JSON text out** — the WASM module writes the whole answer as JSON
   text. `run()` returns that text, `runBytes()` hands its raw bytes to
   the driver, and `main.ts` streams the bytes straight to the output
   file, so the ~12 MB answer is never parsed into objects, never
   re-serialised, and never even decoded to a JS string. Stray CR,
   unterminated quotes and quote junk are rare, so they live on slow
   paths that never touch the common case.

## Layout

- `assembly/index.ts` — AssemblyScript source (the parser).
- `reader.wasm` — compiled WASM binary, shipped in the repo.
- `solve.js` — `run(input)` entry point.
- `main.ts` — harness driver.
- `package.json` — `{"type": "module"}`.
- `.makefun/owner.json` — payout wallet.
- `LICENSE` — MIT.
