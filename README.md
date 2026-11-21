# csv-reader-speed-01 — fast drop-in for csv-reader 1.0.0

![Competition](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)
![Rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/sandytaztaz-hue/csv-reader-speed-01-run-20261121/rank.svg)
![Reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/sandytaztaz-hue/csv-reader-speed-01-run-20261121/reward.svg)

[csv-reader-speed-01-run-20261121 on make.fun](https://make.fun/competitions/csv-reader-speed-01-run-20261121)

A faster drop-in replacement for csv-reader 1.0.0, written fresh from the
competition spec. `solve.js` exports `run({text, header})` returning
`{columns, rows, errors}`, exactly per the spec.

## How it is fast

The common path never loops character-by-character: for each record it takes
one line with a single `indexOf('\n')`, and if that line holds no quote and no
stray CR it splits the whole line at once with `String.split(',')` (V8 C++
speed) — all fields in one call, no per-field objects. Only records containing
a quote or a CR fall back to a field-by-field parser that jumps between
delimiters with `indexOf` and slices fields in bulk. No dependencies, no
state between calls, deterministic.

## v4: byte-path driver

`main.ts` reads `cases.json` as a raw Buffer and walks it structurally —
no whole-file utf8 decode, no whole-file `JSON.parse`. Each case's `text`
string is decoded by the native JSON parser applied to that one string
token only, and each answer is serialised per row with the native
`JSON.stringify` and streamed out per case — no whole-answers stringify,
no 12 MB intermediate string. The parser also tracks the next line break
across a record instead of re-scanning for `'\n'` on every unquoted field.
