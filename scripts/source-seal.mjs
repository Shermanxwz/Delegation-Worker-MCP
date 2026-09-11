import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from '../src/paths.mjs';
import { treeDigest } from './tree-digest.mjs';

function command(argv) {
  const result = spawnSync(argv[0], argv.slice(1), { cwd: projectRoot, stdio: 'inherit', env: process.env });
  if (result.status !== 0) throw new Error(`command failed: ${argv.join(' ')}`);
}
function output(argv) {
  const result = spawnSync(argv[0], argv.slice(1), { cwd: projectRoot, encoding: 'utf8', env: process.env });
  if (result.status !== 0) throw new Error(`command failed: ${argv.join(' ')}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

const dirty = output(['git', 'status', '--porcelain']);
if (dirty) throw new Error('source seal requires a clean git tree before evidence is generated');
const candidate = output(['git', 'rev-parse', 'HEAD']);
command(['npm', 'test']);
command(['npm', 'run', 'check']);
command(['npm', 'run', 'verify:upstream']);

const lock = JSON.parse(await fs.readFile(path.join(projectRoot, 'tests', 'upstream-lock.json'), 'utf8'));
const tree = await treeDigest(projectRoot);
const evidence = {
  schemaVersion: 1,
  kind: 'SOURCE_SEAL',
  eligible: true,
  status: 'SOURCE_SEALED',
  candidate,
  upstream: { repository: lock.repository, commit: lock.commit },
  tree,
  gates: ['tests', 'static-check', 'pinned-upstream-contracts'],
  generatedAt: new Date().toISOString()
};
const dir = path.join(projectRoot, '.seal');
await fs.mkdir(dir, { recursive: true, mode: 0o700 });
await fs.writeFile(path.join(dir, 'source.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
console.log(`SOURCE_SEALED candidate=${candidate} digest=${tree.digest}`);
