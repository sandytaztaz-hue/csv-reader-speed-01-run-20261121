# csv-reader-speed-01-run-20261121

![Competition](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)
![Rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/sandytaztaz-hue/csv-reader-speed-01-run-20261121/rank.svg)
![Reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/sandytaztaz-hue/csv-reader-speed-01-run-20261121/reward.svg)

[csv-reader-speed-01-run-20261121 on make.fun](https://make.fun/competitions/csv-reader-speed-01-run-20261121)

A fast drop-in replacement for csv-reader 1.0.0, written from the behaviour
spec in `CSV_SPEC.md`. It returns exactly csv-reader 1.0.0's answer for every
input — same values, same errors, same order — and is much faster than the
reference (~1.6–2.0 s CPU per 6-case set of ~10.2 MB; this entry aims well
under 0.5 s).

## How it is fast

The common path never loops character-by-character in JS. An unquoted field
jumps with `String.indexOf` to the next `,`, LF, or CR and is sliced in bulk;
a quoted field jumps with `indexOf('"', …)` to its closing quote (skipping
`""` pairs) and is sliced directly when the span holds no escapes or
newlines. Concatenation and line counting happen only on the rare paths: a
stray CR, `""` escapes, or a newline inside a quoted field.

## Files

- `solve.js` — the parser. ES module, exports `run(input)`. Dependency-free,
  no WebAssembly, no native addons, no network, no clock, no randomness, no
  state kept between calls: two runs on the same input give byte-identical
  output.
- `main.ts` — the driver the harness runs (`node /bot/main.ts`, Node 22).
  It reads every case from `/input/cases.json` (env `MAKEFUN_INPUT_DIR` /
  `MAKEFUN_OUTPUT_DIR` stand in for `/input` / `/output` outside a
  container), answers each one alone with `run()` from `solve.js`, and
  writes `/output/answers.json` (a JSON array, one answer per case, in the
  cases' order). It sets V8's incremental marking off before importing
  `solve.js`.

## Behaviour covered

BOM stripping, LF / CRLF / lone-CR handling, stray CRs in unquoted fields,
unterminated quotes (re-read as unquoted with the opening quote literal),
quote junk, `""` escapes, newlines inside quoted fields, blank-line
skipping, short/long rows (padded / cut to the first record's width),
header handling (including header with no records), and the single empty
unquoted field that is not a record at all.

Built from the spec only — no reference implementation was read.
