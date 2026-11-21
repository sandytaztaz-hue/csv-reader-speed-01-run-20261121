// Driver for csv-reader-speed-01-run-20261121. Run by the harness as
// `node /bot/main.ts` (Node 22). Reads every case from /input/cases.json
// (or $MAKEFUN_INPUT_DIR/cases.json outside a container), answers each one
// alone with run() from solve.js, and writes /output/answers.json
// (or $MAKEFUN_OUTPUT_DIR/answers.json): a JSON array, one answer per case,
// in the cases' order.

import { setFlagsFromString } from 'node:v8';

// Turn V8's incremental marking off BEFORE importing solve.js, so the
// parser runs under a single uninterrupted marking regime.
setFlagsFromString('--no-incremental-marking');

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Dynamic import: static imports are hoisted and would load solve.js
// before the flag above takes effect.
const { run } = await import('./solve.js');

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
// Each case is {"id", "input"}; answer each one's input alone with run().
const answers = cases.map((c) => run(c.input));

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'answers.json'), JSON.stringify(answers));
