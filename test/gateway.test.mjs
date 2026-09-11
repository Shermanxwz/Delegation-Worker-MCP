import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/store.mjs';
import { SecretVault } from '../src/vault.mjs';
import { ModelGateway } from '../src/gateway.mjs';

async function freePort() { const server = net.createServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r)); const port = server.address().port; await new Promise((r) => server.close(r)); return port; }

test('gateway routes an opaque Codex model alias to the selected provider/model and applies reasoning', async () => {
  let chatRequest = null;
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/v1/responses') { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'responses not supported' })); }
    if (req.url === '/v1/chat/completions') {
      const chunks = []; for await (const c of req) chunks.push(c); chatRequest = JSON.parse(Buffer.concat(chunks));
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r)); const upstreamPort = upstream.address().port;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dwmcp-gateway-')); const gatewayPort = await freePort(); const env = { ...process.env, DWMCP_DATA_DIR: dir, DWMCP_GATEWAY_PORT: String(gatewayPort) };
  const store = new StateStore({ env }); const vault = new SecretVault({ env });
  const provider = await store.saveProvider({ name: 'Upstream', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, adapter: 'openai-compatible' });
  const capability = { kind: 'effort', advertised: true, source: 'upstream_metadata', requestStyle: 'openai_reasoning', options: [{ value: 'auto', label: 'Auto' }, { value: 'high', label: 'High' }], default: 'auto' };
  const alias = await store.createRoute({ providerId: provider.id, modelId: 'real-model', reasoning: 'high', capability });
  const gateway = new ModelGateway({ store, vault, env }); await gateway.start(); const token = await store.gatewayToken();
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: alias, input: 'hello', stream: false }) });
  assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.object, 'response'); assert.equal(body.output[0].content[0].text, 'ok');
  assert.equal(chatRequest.model, 'real-model'); assert.equal(chatRequest.reasoning_effort, 'high');
  await gateway.close(); await new Promise((r) => upstream.close(r));
});

test('gateway exposes route aliases as Codex ModelsResponse with probed ModelInfo', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dwmcp-model-catalog-'));
  const gatewayPort = await freePort();
  const env = { ...process.env, DWMCP_DATA_DIR: dir, DWMCP_GATEWAY_PORT: String(gatewayPort) };
  const store = new StateStore({ env });
  const vault = new SecretVault({ env });
  const provider = await store.saveProvider({ name: 'Upstream', baseUrl: 'https://example.com/v1', adapter: 'openai-compatible' });
  await store.setProviderModels(provider.id, [{
    id: 'real-model',
    name: 'Real Model',
    reasoning: { kind: 'unknown', options: [{ value: 'auto', label: 'Auto' }], default: 'auto' },
    codex: { source: 'unknown', functionTools: null, customTools: null, mcpTools: null, inputModalities: [] },
    probe: {
      ok: true,
      protocol: 'responses',
      grade: 'full-candidate',
      probedAt: new Date().toISOString(),
      codex: { functionTools: true, customTools: true, mcpTools: true, parallelToolCalls: null }
    }
  }]);
  const alias = await store.createRoute({ providerId: provider.id, modelId: 'real-model', reasoning: 'auto', capability: null });
  const gateway = new ModelGateway({ store, vault, env });
  await gateway.start();
  const token = await store.gatewayToken();
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`, {
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(Array.isArray(body.models), true);
  const model = body.models.find((entry) => entry.slug === alias);
  assert.ok(model);
  assert.equal(model.shell_type, 'unified_exec');
  assert.equal(model.apply_patch_tool_type, 'freeform');
  assert.deepEqual(model.input_modalities, ['text']);
  assert.match(model.base_instructions, /coding agent/i);
  assert.equal(body.data, undefined);
  await gateway.close();
});

test('gateway keeps native apply_patch disabled when custom/freeform tools were not proven', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dwmcp-model-catalog-conservative-'));
  const gatewayPort = await freePort();
  const env = { ...process.env, DWMCP_DATA_DIR: dir, DWMCP_GATEWAY_PORT: String(gatewayPort) };
  const store = new StateStore({ env });
  const vault = new SecretVault({ env });
  const provider = await store.saveProvider({ name: 'Upstream', baseUrl: 'https://example.com/v1', adapter: 'openai-compatible' });
  await store.setProviderModels(provider.id, [{
    id: 'function-only',
    name: 'Function Only',
    reasoning: { kind: 'unknown', options: [{ value: 'auto', label: 'Auto' }], default: 'auto' },
    codex: { source: 'unknown', functionTools: null, customTools: null, mcpTools: null, inputModalities: [] },
    probe: {
      ok: true,
      protocol: 'responses',
      grade: 'responses-function',
      probedAt: new Date().toISOString(),
      codex: { functionTools: true, customTools: false, mcpTools: true, parallelToolCalls: null }
    }
  }]);
  const alias = await store.createRoute({ providerId: provider.id, modelId: 'function-only', reasoning: 'auto', capability: null });
  const gateway = new ModelGateway({ store, vault, env });
  await gateway.start();
  const token = await store.gatewayToken();
  const body = await (await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`, {
    headers: { authorization: `Bearer ${token}` }
  })).json();
  const model = body.models.find((entry) => entry.slug === alias);
  assert.equal(model.shell_type, 'unified_exec');
  assert.equal(model.apply_patch_tool_type, null);
  await gateway.close();
});
