import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/store.mjs';

test('session modes and profiles are isolated by official Codex thread id', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dwmcp-session-'));
  const store = new StateStore({ env: { ...process.env, DWMCP_DATA_DIR: dir } });
  await store.setProfile({ providerId: 'p_one', modelId: 'model-a', reasoning: 'high' }, 'thread-a');
  await store.setSessionMode('thread-a', 'WORKER');
  const a = await store.getSession('thread-a');
  const b = await store.getSession('thread-b');
  assert.equal(a.mode, 'WORKER');
  assert.equal(a.profile.providerId, 'p_one');
  assert.equal(b.mode, 'NATIVE');
  assert.notEqual(b.profile.providerId, 'p_one');
});

test('legacy global profile migrates to v0.2 default without enabling Worker mode', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dwmcp-migrate-'));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ schemaVersion: 1, profile: { enabled: true, providerId: 'legacy', modelId: 'm', reasoning: 'low' } }));
  const store = new StateStore({ env: { ...process.env, DWMCP_DATA_DIR: dir } });
  const state = await store.read();
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.defaultProfile.providerId, 'legacy');
  assert.equal(state.defaultMode, 'NATIVE');
});
