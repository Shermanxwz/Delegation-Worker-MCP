import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/store.mjs';
import { TaskStore } from '../src/task-store.mjs';
import { WorkerManager } from '../src/worker-manager.mjs';

class FakeClient {
  async start() { return this; }
  async runThread(opts) {
    opts.onProgress?.({ method: 'thread/started', params: { threadId: opts.sandbox === 'read-only' ? 'verify-thread' : 'worker-thread' } });
    opts.onProgress?.({ method: 'turn/started', params: { threadId: opts.sandbox === 'read-only' ? 'verify-thread' : 'worker-thread', turn: { id: opts.sandbox === 'read-only' ? 'verify-turn' : 'worker-turn' } } });
    return { threadId: opts.sandbox === 'read-only' ? 'verify-thread' : 'worker-thread', turnId: opts.sandbox === 'read-only' ? 'verify-turn' : 'worker-turn', status: 'completed', output: opts.sandbox === 'read-only' ? 'verification ok' : 'implementation ok', messages: [] };
  }
  async close() {}
  async steer() {}
  async interrupt() {}
}

test('Worker model/access are taken from human profile, not worker_start arguments', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dwmcp-worker-')); const env = { ...process.env, DWMCP_DATA_DIR: dir };
  const store = new StateStore({ env }); const taskStore = new TaskStore({ env });
  const provider = await store.saveProvider({ name: 'P', baseUrl: 'https://example.com/v1', adapter: 'openai-compatible' });
  await store.setProviderModels(provider.id, [{ id: 'mini', name: 'Mini', reasoning: { kind: 'toggle', advertised: true, source: 'upstream_metadata', requestStyle: 'thinking_flag', options: [{ value: 'auto', label: 'Auto' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }], default: 'auto' } }]);
  await store.setProfile({ enabled: true, providerId: provider.id, modelId: 'mini', reasoning: 'on', access: 'danger-full-access', autoVerify: true });
  const manager = new WorkerManager({ store, taskStore, env, codexConfig: { status: async () => ({ installed: true }) }, clientFactory: () => new FakeClient() });
  const started = await manager.start({ task: 'Do work', cwd: '/tmp' });
  const done = await manager.wait(started.taskId, 3000);
  assert.equal(done.status, 'completed'); assert.equal(done.model.id, 'mini'); assert.equal(done.reasoning, 'on'); assert.equal(done.access, 'danger-full-access'); assert.equal(done.verification.output, 'verification ok');
});
