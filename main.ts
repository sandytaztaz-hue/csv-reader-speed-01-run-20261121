import { setFlagsFromString } from 'node:v8';
setFlagsFromString('--no-incremental-marking');
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const { run } = await import('./solve.js');

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = await readFile(join(inputDir, 'cases.json'), 'utf8');
const cases = JSON.parse(raw);

const answers = [];
for (const c of cases) answers.push(run(c.input ?? c));
await mkdir(outputDir, { recursive: true });
await writeFile(join(outputDir, 'answers.json'), JSON.stringify(answers));
