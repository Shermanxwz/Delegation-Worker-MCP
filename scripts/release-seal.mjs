import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from '../src/paths.mjs';

function head() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('cannot resolve candidate git SHA');
  return result.stdout.trim();
}
async function evidence(name) {
  try { return JSON.parse(await fs.readFile(path.join(projectRoot, '.seal', name), 'utf8')); }
  catch (error) { throw new Error(`missing or invalid .seal/${name}: ${error.message}`); }
}

const candidate = head();
const source = await evidence('source.json');
const simulated = await evidence('simulated-target.json');
const target = await evidence('target.json');
if (source.eligible !== true || source.status !== 'SOURCE_SEALED') throw new Error('source evidence is not eligible');
if (simulated.eligible !== true || simulated.status !== 'SIMULATED_TARGET_SEALED') throw new Error('simulated target evidence is not eligible');
if (target.eligible !== true || target.status !== 'TARGET_SEALED') throw new Error('target evidence is not eligible');
if (source.candidate !== candidate || simulated.candidate !== candidate || target.candidate !== candidate) throw new Error('source/simulated/target evidence must point to the exact current candidate');
if (source.upstream?.commit !== simulated.upstream?.commit || source.upstream?.commit !== target.upstream?.commit) throw new Error('source/simulated/target upstream Codex pin differs');
if (!target.host?.codexBinary?.sha256 || !target.host?.codexBinary?.version) throw new Error('real target evidence is missing Codex binary identity');
if (source.upstream?.expectedRuntimeVersion && !String(target.host.codexBinary.version).includes(source.upstream.expectedRuntimeVersion)) throw new Error('real target Codex runtime version differs from sealed source release');

const sealed = {
  schemaVersion: 2,
  eligible: true,
  status: 'ARCHIVE_READY',
  candidate,
  upstream: source.upstream,
  source: { tree: source.tree, generatedAt: source.generatedAt },
  simulatedTarget: { proofs: simulated.proofs, generatedAt: simulated.generatedAt },
  target: { host: target.host, provider: target.provider, model: target.model, generatedAt: target.generatedAt },
  generatedAt: new Date().toISOString()
};
await fs.writeFile(path.join(projectRoot, '.seal', 'SEALED.json'), `${JSON.stringify(sealed, null, 2)}\n`, { mode: 0o600 });
console.log(`ARCHIVE_READY candidate=${candidate}`);