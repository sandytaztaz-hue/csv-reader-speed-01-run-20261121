// Driver: reads every case from $MAKEFUN_INPUT_DIR/cases.json (or /input),
// answers each one alone with run() from solve.js, and writes the answers
// array (one per case, in order) to $MAKEFUN_OUTPUT_DIR/answers.json
// (or /output). V8 incremental marking is switched off before solve.js is
// imported so the timed run is not perturbed by background GC marking.
import { setFlagsFromString } from 'node:v8';
setFlagsFromString('--no-incremental-marking');
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const { run } = await import('./solve.js');

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = await readFile(join(inputDir, 'cases.json'), 'utf8');
const cases = JSON.parse(raw);
if (!Array.isArray(cases)) throw new Error('cases.json must hold a JSON array of cases');

const answers = [];
for (const c of cases) answers.push(run(c.input ?? c));
await mkdir(outputDir, { recursive: true });
await writeFile(join(outputDir, 'answers.json'), JSON.stringify(answers));
