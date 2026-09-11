import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const UI_EXTENSION = 'io.modelcontextprotocol/ui';
const APP_MIME = 'text/html;profile=mcp-app';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function spawnMcp(prefix = 'dwmcp-mcp-') {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const port = await freePort();
  const child = spawn(process.execPath, ['mcp/server.mjs'], {
    cwd: path.resolve('.'),
    env: { ...process.env, HOME: home, DWMCP_DATA_DIR: path.join(home, 'data'), DWMCP_GATEWAY_PORT: String(port) },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (value) => { stderr += value; });
  return { child, home, call: rpcClient(child), stderr: () => stderr };
}

async function stopMcp(instance) {
  instance.child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 1500);
    instance.child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

function rpcClient(child) {
  let buffer = '';
  const waits = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    while (true) {
      const index = buffer.indexOf('\n');
      if (index < 0) break;
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = waits.get(message.id);
      if (waiter) { waits.delete(message.id); waiter.resolve(message); }
    }
  });
  let id = 1;
  return (method, params = {}) => new Promise((resolve, reject) => {
    const current = id++;
    const timer = setTimeout(() => {
      waits.delete(current);
      reject(new Error(`timeout ${method}`));
    }, 5000);
    waits.set(current, { resolve: (value) => { clearTimeout(timer); resolve(value); } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: current, method, params })}\n`);
  });
}

function structured(message) {
  const result = message?.result;
  if (result?.structuredContent !== undefined) return result.structuredContent;
  return JSON.parse(result?.content?.[0]?.text || '{}');
}

function appCapabilities() {
  return { extensions: { [UI_EXTENSION]: { mimeTypes: [APP_MIME] } } };
}

function modernMeta({ app = false, threadId = '' } = {}) {
  return {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'modern-test', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': app ? appCapabilities() : {},
    ...(threadId ? { threadId } : {})
  };
}

test('legacy MCP Apps host receives human control tools and thread-bound Worker state', async () => {
  const instance = await spawnMcp();
  try {
    const init = await instance.call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: appCapabilities(),
      clientInfo: { name: 'test', version: '1' }
    });
    assert.equal(init.result.serverInfo.name, 'delegation-worker-mcp');
    assert.equal(init.result.serverInfo.version, '0.3.0');
    assert.deepEqual(init.result.capabilities.extensions[UI_EXTENSION].mimeTypes, [APP_MIME]);
    instance.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

    const listed = await instance.call('tools/list');
    const panel = listed.result.tools.find((tool) => tool.name === 'worker_panel');
    assert.equal(panel._meta.ui.resourceUri, 'ui://delegation-worker/control');
    const human = listed.result.tools.find((tool) => tool.name === 'provider_save');
    assert.deepEqual(human._meta.ui.visibility, ['app']);
    assert.equal(human.inputSchema.properties.headers.type, 'object');

    const start = listed.result.tools.find((tool) => tool.name === 'worker_start');
    assert.equal('providerId' in start.inputSchema.properties, false);
    assert.equal('access' in start.inputSchema.properties, false);
    assert.ok(listed.result.tools.some((tool) => tool.name === 'worker_extend'));
    assert.ok(listed.result.tools.some((tool) => tool.name === 'worker_respond'));

    const metaA = { threadId: 'official-thread-a' };
    const metaB = { threadId: 'official-thread-b' };
    let mode = structured(await instance.call('tools/call', { name: 'session_mode_get', arguments: {}, _meta: metaA }));
    assert.equal(mode.mode, 'NATIVE');
    structured(await instance.call('tools/call', { name: 'session_mode_set', arguments: { mode: 'WORKER' }, _meta: metaA }));
    mode = structured(await instance.call('tools/call', { name: 'session_mode_get', arguments: {}, _meta: metaA }));
    assert.equal(mode.mode, 'WORKER');
    const other = structured(await instance.call('tools/call', { name: 'session_mode_get', arguments: {}, _meta: metaB }));
    assert.equal(other.mode, 'NATIVE');

    const resources = await instance.call('resources/list');
    assert.equal(resources.result.resources[0].mimeType, APP_MIME);
    const read = await instance.call('resources/read', { uri: 'ui://delegation-worker/control' });
    assert.match(read.result.contents[0].text, /ui\/initialize/);
    assert.match(read.result.contents[0].text, /原生/);
    assert.match(read.result.contents[0].text, /Worker/);
  } finally {
    await stopMcp(instance);
  }
  assert.equal(instance.stderr().includes('gateway unavailable'), false, instance.stderr());
});

test('legacy non-App hosts cannot discover or invoke privileged human control tools', async () => {
  const instance = await spawnMcp('dwmcp-mcp-no-ui-');
  try {
    await instance.call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'hermes-like-host', version: '1' }
    });
    const listed = await instance.call('tools/list');
    const names = listed.result.tools.map((tool) => tool.name);
    assert.equal(names.includes('provider_save'), false);
    assert.equal(names.includes('worker_profile_set'), false);
    assert.equal(names.includes('session_mode_set'), false);
    assert.equal(names.includes('codex_install'), false);
    assert.equal(names.includes('worker_panel'), false);
    assert.equal(names.includes('worker_start'), true);

    const denied = await instance.call('tools/call', {
      name: 'provider_save',
      arguments: { name: 'Nope', baseUrl: 'https://example.com/v1' }
    });
    assert.equal(denied.result.isError, true);
    assert.equal(structured(denied).code, 'MCP_APP_CAPABILITY_REQUIRED');

    const resources = await instance.call('resources/list');
    assert.deepEqual(resources.result.resources, []);
  } finally {
    await stopMcp(instance);
  }
});

test('modern 2026-07-28 stdio supports discovery, per-request identity and App capability gating', async () => {
  const instance = await spawnMcp('dwmcp-mcp-modern-');
  try {
    const discover = await instance.call('server/discover', { _meta: modernMeta() });
    assert.equal(discover.result.resultType, 'complete');
    assert.ok(discover.result.supportedVersions.includes('2026-07-28'));
    assert.equal(discover.result._meta['io.modelcontextprotocol/serverInfo'].name, 'delegation-worker-mcp');
    assert.deepEqual(discover.result.capabilities.extensions[UI_EXTENSION].mimeTypes, [APP_MIME]);

    const ordinary = await instance.call('tools/list', { _meta: modernMeta() });
    assert.equal(ordinary.result.resultType, 'complete');
    assert.equal(ordinary.result.cacheScope, 'private');
    assert.equal(ordinary.result._meta['io.modelcontextprotocol/serverInfo'].version, '0.3.0');
    assert.equal(ordinary.result.tools.some((tool) => tool.name === 'provider_save'), false);

    const appList = await instance.call('tools/list', { _meta: modernMeta({ app: true }) });
    assert.equal(appList.result.tools.some((tool) => tool.name === 'provider_save'), true);
    assert.equal(appList.result.tools.some((tool) => tool.name === 'worker_panel'), true);

    const meta = modernMeta({ app: true, threadId: 'modern-thread' });
    structured(await instance.call('tools/call', {
      name: 'session_mode_set',
      arguments: { mode: 'WORKER' },
      _meta: meta
    }));
    const mode = structured(await instance.call('tools/call', {
      name: 'session_mode_get',
      arguments: {},
      _meta: meta
    }));
    assert.equal(mode.mode, 'WORKER');

    const resources = await instance.call('resources/list', { _meta: modernMeta({ app: true }) });
    assert.equal(resources.result.resources[0].mimeType, APP_MIME);
    assert.equal(resources.result.resultType, 'complete');

    const unsupported = await instance.call('tools/list', {
      _meta: {
        ...modernMeta(),
        'io.modelcontextprotocol/protocolVersion': '2027-01-01'
      }
    });
    assert.equal(unsupported.error.code, -32022);
  } finally {
    await stopMcp(instance);
  }
});
