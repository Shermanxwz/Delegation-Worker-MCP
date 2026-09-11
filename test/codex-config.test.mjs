import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexConfigManager, CODEX_PROVIDER_ID, inspectTopLevelSelectors } from '../src/codex-config.mjs';

test('Codex install adds only a namespaced provider and preserves official selectors', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dwmcp-codex-'));
  const codex = path.join(home, '.codex'); await fs.mkdir(codex, { recursive: true });
  const initial = 'model_provider = "openai"\nmodel = "gpt-test"\n\n[features]\nfoo = true\n';
  await fs.writeFile(path.join(codex, 'config.toml'), initial);
  const env = { ...process.env, HOME: home, DWMCP_DATA_DIR: path.join(home, 'data'), DWMCP_GATEWAY_PORT: '18991' };
  const manager = new CodexConfigManager({ env }); await manager.install();
  const after = await manager.read();
  assert.deepEqual(inspectTopLevelSelectors(after), inspectTopLevelSelectors(initial));
  assert.ok(after.includes(`[model_providers.${CODEX_PROVIDER_ID}]`));
  assert.ok(after.includes('http://127.0.0.1:18991/v1'));
  await manager.uninstall();
  const final = await manager.read(); assert.deepEqual(inspectTopLevelSelectors(final), inspectTopLevelSelectors(initial));
});
