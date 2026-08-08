// Cross-platform file discovery for `npm test`.
//
// The script used to be `node --test test/*.test.js`, relying on the shell
// to expand the glob before node ever saw it — true on bash/zsh, not true on
// PowerShell (the default shell for `run:` steps on windows-latest Actions
// runners, and what most Windows contributors run locally), which passes the
// literal unexpanded string through. Node's own glob support doesn't save
// this either: it resolves the pattern against cwd with the OS path
// separator first, and on Windows that turns `test/*.test.js` into
// `test\*.test.js` — where backslash is glob's own escape character, so
// `\*` becomes a literal asterisk instead of a wildcard, matching nothing.
//
// Sidestepping both: list the directory ourselves with fs.readdirSync (no
// glob, no shell) and hand node --test an explicit file list.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = 'test';
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => join(dir, f));

if (files.length === 0) {
  console.error(`No *.test.js files found in ${dir}/`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
