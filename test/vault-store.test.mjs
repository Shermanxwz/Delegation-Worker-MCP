import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SecretVault } from '../src/vault.mjs';
import { StateStore } from '../src/store.mjs';

test('vault encrypts provider keys and public provider state never returns ciphertext', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dwmcp-vault-'));
  const env = { ...process.env, DWMCP_DATA_DIR: dir };
  const vault = new SecretVault({ env }); const store = new StateStore({ env });
  const cipher = await vault.encrypt('sk-super-secret');
  assert.ok(!cipher.includes('sk-super-secret'));
  assert.equal(await vault.decrypt(cipher), 'sk-super-secret');
  const provider = await store.saveProvider({ name: 'P', baseUrl: 'https://example.com/v1', apiKeyCipher: cipher, adapter: 'openai-compatible' });
  assert.equal(provider.apiKeyConfigured, true);
  assert.equal('apiKeyCipher' in provider, false);
  const listed = await store.listProviders();
  assert.equal('apiKeyCipher' in listed[0], false);
  const token1 = await store.gatewayToken(); const token2 = await store.gatewayToken();
  assert.equal(token1, token2); assert.match(token1, /^[A-Za-z0-9_-]{43}$/);
});
