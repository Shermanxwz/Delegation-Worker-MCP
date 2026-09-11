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
command(['npm', 'run', 'seal:simulated-target']);

const lock = JSON.parse(await fs.readFile(path.join(projectRoot, 'tests', 'upstream-lock.json'), 'utf8'));
const simulated = JSON.parse(await fs.readFile(path.join(projectRoot, '.seal', 'simulated-target.json'), 'utf8'));
if (simulated.eligible !== true || simulated.status !== 'SIMULATED_TARGET_SEALED' || simulated.candidate !== candidate) {
  throw new Error('simulated target evidence is not eligible for the current candidate');
}
if (simulated.upstream?.commit !== lock.commit) throw new Error('simulated target upstream pin differs');
const tree = await treeDigest(projectRoot);
const evidence = {
  schemaVersion: 2,
  kind: 'SOURCE_SEAL',
  eligible: true,
  status: 'SOURCE_SEALED',
  candidate,
  upstream: {
    repository: lock.repository,
    release: lock.release,
    tag: lock.tag,
    commit: lock.commit,
    expectedRuntimeVersion: lock.expectedRuntimeVersion
  },
  tree,
  simulatedTarget: {
    status: simulated.status,
    generatedAt: simulated.generatedAt,
    proofs: simulated.proofs
  },
  gates: ['tests', 'static-check', 'pinned-stable-upstream-contracts', 'simulated-target-chain'],
  generatedAt: new Date().toISOString()
};
const dir = path.join(projectRoot, '.seal');
await fs.mkdir(dir, { recursive: true, mode: 0o700 });
await fs.writeFile(path.join(dir, 'source.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
console.log(`SOURCE_SEALED candidate=${candidate} digest=${tree.digest}`);