import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

async function freePort() { const server = net.createServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r)); const port = server.address().port; await new Promise((r) => server.close(r)); return port; }

function rpcClient(child) {
  let buffer = ''; const waits = new Map();
  child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk) => { buffer += chunk; while (true) { const i = buffer.indexOf('\n'); if (i < 0) break; const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1); if (!line) continue; const m = JSON.parse(line); const waiter = waits.get(m.id); if (waiter) { waits.delete(m.id); waiter.resolve(m); } } });
  let id = 1;
  return (method, params = {}) => new Promise((resolve, reject) => { const current = id++; const timer = setTimeout(() => { waits.delete(current); reject(new Error(`timeout ${method}`)); }, 5000); waits.set(current, { resolve: (v) => { clearTimeout(timer); resolve(v); } }); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: current, method, params })}\n`); });
}

test('MCP server exposes a stable Worker App resource and keeps secret tools app-only', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dwmcp-mcp-')); const port = await freePort();
  const child = spawn(process.execPath, ['mcp/server.mjs'], { cwd: path.resolve('.'), env: { ...process.env, HOME: home, DWMCP_DATA_DIR: path.join(home, 'data'), DWMCP_GATEWAY_PORT: String(port) }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', (x) => { stderr += x; });
  const call = rpcClient(child);
  try {
    const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'delegation-worker-mcp');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
    const listed = await call('tools/list');
    const panel = listed.result.tools.find((x) => x.name === 'worker_panel'); assert.equal(panel._meta.ui.resourceUri, 'ui://delegation-worker/control');
    const secret = listed.result.tools.find((x) => x.name === 'provider_save'); assert.deepEqual(secret._meta.ui.visibility, ['app']);
    const resources = await call('resources/list'); assert.equal(resources.result.resources[0].mimeType, 'text/html;profile=mcp-app');
    const read = await call('resources/read', { uri: 'ui://delegation-worker/control' }); assert.match(read.result.contents[0].text, /ui\/initialize/); assert.match(read.result.contents[0].text, /开启 Worker/);
  } finally {
    child.kill('SIGTERM'); await new Promise((r) => { const timer = setTimeout(r, 1500); child.once('exit', () => { clearTimeout(timer); r(); }); });
  }
  assert.equal(stderr.includes('gateway unavailable'), false, stderr);
});
