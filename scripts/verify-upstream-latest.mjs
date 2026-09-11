import fs from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from '../src/paths.mjs';

const lock = JSON.parse(await fs.readFile(path.join(projectRoot, 'tests', 'upstream-lock.json'), 'utf8'));
const releaseResponse = await fetch('https://api.github.com/repos/openai/codex/releases/latest', {
  headers: { 'accept': 'application/vnd.github+json', 'user-agent': 'delegation-worker-mcp-upstream-canary' },
  signal: AbortSignal.timeout(20000)
});
if (!releaseResponse.ok) throw new Error(`latest Codex release lookup failed: HTTP ${releaseResponse.status}`);
const release = await releaseResponse.json();
const tag = String(release?.tag_name || '');
if (!/^rust-v\d+\.\d+\.\d+/.test(tag)) throw new Error(`unexpected latest Codex release tag: ${tag || '<empty>'}`);

const failures = [];
async function fetchLatest(filePath) {
  const url = `https://raw.githubusercontent.com/${lock.repository}/${tag}/${filePath}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

for (const contract of lock.contracts || []) {
  let text;
  try {
    text = await fetchLatest(contract.path);
  } catch (error) {
    failures.push(`${contract.path}: fetch failed: ${error.message}`);
    continue;
  }
  for (const needle of contract.needles || []) {
    if (!text.includes(needle)) failures.push(`${contract.path}: missing ${JSON.stringify(needle)}`);
  }
}

if (failures.length) {
  console.error(`LATEST_UPSTREAM_DRIFT tag=${tag}\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`LATEST_UPSTREAM_CONTRACT_OK tag=${tag} pinned=${lock.tag} contracts=${lock.contracts.length}`);
