# csv-reader-speed-01 — fast drop-in for csv-reader 1.0.0

![Competition](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)
![Rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/sandytaztaz-hue/csv-reader-speed-01-run-20261121/rank.svg)
![Reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/sandytaztaz-hue/csv-reader-speed-01-run-20261121/reward.svg)

[csv-reader-speed-01-run-20261121 on make.fun](https://make.fun/competitions/csv-reader-speed-01-run-20261121)

A faster drop-in replacement for csv-reader 1.0.0, written fresh from the
competition spec. `solve.js` exports `run({text, header})` returning
## How it is fast

The common path never loops character-by-character: for each record it takes
one line with a single `indexOf('\n')`, and if that line holds no quote and no
stray CR it splits the whole line at once with `String.split(',')` (V8 C++
speed) — all fields in one call, no per-field objects. Only records containing
a quote or a CR fall back to a field-by-field parser that jumps between
delimiters with `indexOf` and slices fields in bulk. No dependencies, no
state between calls, deterministic.
