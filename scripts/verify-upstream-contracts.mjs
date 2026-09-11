import fs from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from '../src/paths.mjs';

const lock = JSON.parse(await fs.readFile(path.join(projectRoot, 'tests', 'upstream-lock.json'), 'utf8'));
if (!/^[0-9a-f]{40}$/.test(lock.commit)) throw new Error('upstream lock must pin an exact 40-character Codex commit');
if (lock.repository !== 'openai/codex') throw new Error('unexpected upstream repository');

const failures = [];
for (const contract of lock.contracts || []) {
  const url = `https://raw.githubusercontent.com/${lock.repository}/${lock.commit}/${contract.path}`;
  let text;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    text = await response.text();
  } catch (error) {
    failures.push(`${contract.path}: fetch failed: ${error.message}`);
    continue;
  }
  for (const needle of contract.needles || []) if (!text.includes(needle)) failures.push(`${contract.path}: missing ${JSON.stringify(needle)}`);
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`UPSTREAM_CONTRACT_OK repository=${lock.repository} commit=${lock.commit} contracts=${lock.contracts.length}`);
