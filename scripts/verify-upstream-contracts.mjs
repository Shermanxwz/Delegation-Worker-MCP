import fs from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from '../src/paths.mjs';

const lock = JSON.parse(await fs.readFile(path.join(projectRoot, 'tests', 'upstream-lock.json'), 'utf8'));
if (!/^[0-9a-f]{40}$/.test(lock.commit)) throw new Error('upstream lock must pin an exact 40-character Codex commit');
if (lock.repository !== 'openai/codex') throw new Error('unexpected upstream repository');

const failures = [];

async function fetchPinned(filePath) {
  const url = `https://raw.githubusercontent.com/${lock.repository}/${lock.commit}/${filePath}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

for (const contract of lock.contracts || []) {
  let text;
  try {
    text = await fetchPinned(contract.path);
  } catch (error) {
    failures.push(`${contract.path}: fetch failed: ${error.message}`);
    continue;
  }
  for (const needle of contract.needles || []) if (!text.includes(needle)) failures.push(`${contract.path}: missing ${JSON.stringify(needle)}`);
}
for (const vendored of lock.vendored || []) {
  try {
    const [upstreamText, localText] = await Promise.all([
      fetchPinned(vendored.path),
      fs.readFile(path.join(projectRoot, vendored.localPath), 'utf8')
    ]);
    if (localText !== upstreamText) failures.push(`${vendored.localPath}: does not exactly match pinned upstream ${vendored.path}`);
  } catch (error) {
    failures.push(`${vendored.localPath}: vendor verification failed: ${error.message}`);
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`UPSTREAM_CONTRACT_OK repository=${lock.repository} commit=${lock.commit} contracts=${lock.contracts.length} vendored=${(lock.vendored || []).length}`);