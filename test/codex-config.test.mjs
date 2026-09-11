import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CodexConfigManager, CODEX_GATEWAY_BASE_URL_ENV, CODEX_GATEWAY_TOKEN_ENV,
  inspectTopLevelSelectors
} from '../src/codex-config.mjs';

test('Codex integration is process-scoped and never adds a persistent provider', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dwmcp-codex-'));
  const codex = path.join(home, '.codex'); await fs.mkdir(codex, { recursive: true });
  const initial = 'model_provider = "openai"\nmodel = "gpt-test"\n\n[features]\nfoo = true\n';
  await fs.writeFile(path.join(codex, 'config.toml'), initial);
  const env = { ...process.env, HOME: home, DWMCP_DATA_DIR: path.join(home, 'data'), DWMCP_GATEWAY_PORT: '18991' };
  const manager = new CodexConfigManager({ env });
  const result = await manager.install();
  const after = await manager.read();
  assert.deepEqual(inspectTopLevelSelectors(after), inspectTopLevelSelectors(initial));
  assert.equal(after, initial);
  assert.equal(result.processScoped, true);
  assert.equal(result.legacyInstalled, false);

  const runtimeEnv = manager.runtimeEnv('runtime-token', { DWMCP_WORKER_CHILD: '1' });
  assert.equal(runtimeEnv[CODEX_GATEWAY_TOKEN_ENV], 'runtime-token');
  assert.equal(runtimeEnv[CODEX_GATEWAY_BASE_URL_ENV], 'http://127.0.0.1:18991/v1');
  assert.equal(runtimeEnv.DWMCP_WORKER_CHILD, '1');
});

test('Codex install migrates away the legacy managed provider without changing official selectors', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dwmcp-codex-legacy-'));
  const codex = path.join(home, '.codex'); await fs.mkdir(codex, { recursive: true });
  const initial = [
    'model_provider = "openai"',
    'model = "gpt-test"',
    '',
    '# --- delegation-worker-mcp managed provider ---',
    '[model_providers.delegation_worker_gateway]',
    'name = "Delegation Worker Gateway"',
    'base_url = "http://127.0.0.1:8791/v1"',
    'wire_api = "responses"',
    '# --- end delegation-worker-mcp managed provider ---',
    ''
  ].join('\n');
  await fs.writeFile(path.join(codex, 'config.toml'), initial);
  const env = { ...process.env, HOME: home, DWMCP_DATA_DIR: path.join(home, 'data') };
  const manager = new CodexConfigManager({ env });
  const beforeSelectors = inspectTopLevelSelectors(initial);
  const result = await manager.install();
  const after = await manager.read();
  assert.equal(result.removedLegacyProvider, true);
  assert.equal(after.includes('delegation_worker_gateway'), false);
  assert.deepEqual(inspectTopLevelSelectors(after), beforeSelectors);
});
