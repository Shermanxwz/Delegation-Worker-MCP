import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/store.mjs';
import { TaskStore } from '../src/task-store.mjs';
import { WorkerManager } from '../src/worker-manager.mjs';

const reasoning = { kind: 'toggle', advertised: true, source: 'upstream_metadata', requestStyle: 'thinking_flag', options: [{ value: 'auto', label: 'Auto' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }], default: 'auto' };

async function configured() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dwmcp-worker-'));
  const env = { ...process.env, DWMCP_DATA_DIR: dir };
  const store = new StateStore({ env });
  const taskStore = new TaskStore({ env });
  const provider = await store.saveProvider({ name: 'P', baseUrl: 'https://example.com/v1', adapter: 'openai-compatible' });
  await store.setProviderModels(provider.id, [{ id: 'mini', name: 'Mini', reasoning }]);
  await store.setProfile({ providerId: provider.id, modelId: 'mini', reasoning: 'on', access: 'danger-full-access', autoVerify: true }, 'main-thread');
  await store.setSessionMode('main-thread', 'WORKER');
  return { dir, env, store, taskStore, provider };
}

class CompletingClient {
  setServerRequestHandler(handler) { this.serverRequestHandler = handler; }
  async start() { return this; }
  async runThread(opts) {
    const verify = opts.sandbox === 'read-only';
    opts.onProgress?.({ method: 'thread/started', params: { threadId: verify ? 'verify-thread' : 'worker-thread' } });
    opts.onProgress?.({ method: 'turn/started', params: { threadId: verify ? 'verify-thread' : 'worker-thread', turn: { id: verify ? 'verify-turn' : 'worker-turn' } } });
    opts.onProgress?.({ method: 'turn/plan/updated', params: { threadId: verify ? 'verify-thread' : 'worker-thread', explanation: 'execute safely', plan: [{ step: 'inspect', status: 'completed' }, { step: 'implement', status: 'in_progress' }] } });
    return { threadId: verify ? 'verify-thread' : 'worker-thread', turnId: verify ? 'verify-turn' : 'worker-turn', status: 'completed', output: verify ? 'verification ok' : 'implementation ok', messages: [] };
  }
  rejectAllServerRequests() {}
  async close() {}
  async steer() {}
  async interrupt() {}
}

test('Worker route is per supervisor session and completion includes plan + read-only verifier', async () => {
  const { env, store, taskStore } = await configured();
  const manager = new WorkerManager({ store, taskStore, env, codexConfig: { status: async () => ({ installed: true }) }, clientFactory: () => new CompletingClient() });
  await assert.rejects(() => manager.start({ task: 'Do work', cwd: '/tmp', supervisorThreadId: 'other-thread' }), /NATIVE mode/);
  const started = await manager.start({ task: 'Do work', cwd: '/tmp', supervisorThreadId: 'main-thread' });
  const done = await manager.wait(started.taskId, 3000, 'main-thread');
  assert.equal(done.status, 'completed');
  assert.equal(done.model.id, 'mini');
  assert.equal(done.reasoning, 'on');
  assert.equal(done.access, 'danger-full-access');
  assert.equal(done.supervisorThreadId, 'main-thread');
  assert.equal(done.plan.steps[1].step, 'implement');
  assert.equal(done.verification.output, 'verification ok');
  await assert.rejects(() => manager.status(started.taskId, 'other-thread'), /different supervisor session/);
});

class ControlledClient {
  constructor() { this.steers = []; this.interrupts = []; this.responses = []; this.rejects = []; }
  setServerRequestHandler(handler) { this.serverRequestHandler = handler; }
  async start() { return this; }
  runThread(opts) {
    this.opts = opts;
    opts.onProgress?.({ method: 'thread/started', params: { threadId: 'worker-thread' } });
    opts.onProgress?.({ method: 'turn/started', params: { threadId: 'worker-thread', turn: { id: 'worker-turn' } } });
    opts.onProgress?.({ method: 'item/started', params: { threadId: 'worker-thread', turnId: 'worker-turn', item: { type: 'commandExecution', command: 'npm test', status: 'inProgress' } } });
    return new Promise((resolve) => { this.finish = resolve; });
  }
  async steer(threadId, turnId, text) { this.steers.push({ threadId, turnId, text }); }
  async interrupt(threadId, turnId) { this.interrupts.push({ threadId, turnId }); }
  respondServerRequest(id, response) { this.responses.push({ id, response }); return { responded: true, requestId: id }; }
  rejectServerRequest(id, reason) { this.rejects.push({ id, reason }); return { rejected: true, requestId: id }; }
  rejectAllServerRequests() {}
  async close() {}
}

test('supervisor can observe, steer, renew, answer Codex requests and cancel', async () => {
  const { env, store, taskStore } = await configured();
  let client;
  const manager = new WorkerManager({ store, taskStore, env, codexConfig: { status: async () => ({ installed: true }) }, clientFactory: () => (client = new ControlledClient()) });
  const started = await manager.start({ task: 'Long work', cwd: '/tmp', supervisorThreadId: 'main-thread' });
  for (let i = 0; i < 20 && !(await manager.status(started.taskId, 'main-thread')).turnId; i++) await new Promise((r) => setTimeout(r, 10));
  let status = await manager.status(started.taskId, 'main-thread');
  assert.equal(status.latestAction.type, 'commandExecution');
  assert.equal(status.progressEvidence.state, 'progressing');
  const beforeDeadline = Date.parse(status.supervision.leaseDeadlineAt);
  await manager.steer(started.taskId, 'Focus on tests', 'main-thread');
  assert.equal(client.steers.length, 1);
  status = await manager.extend(started.taskId, { extraMs: 10000, reason: 'healthy progress' }, 'main-thread');
  assert.ok(Date.parse(status.supervision.leaseDeadlineAt) > beforeDeadline);
  client.serverRequestHandler({ id: 'req-1', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'q1', question: 'continue?' }] }, receivedAt: new Date().toISOString() });
  await new Promise((r) => setTimeout(r, 20));
  status = await manager.status(started.taskId, 'main-thread');
  assert.equal(status.pendingInteraction.requestId, 'req-1');
  await manager.respond(started.taskId, { requestId: 'req-1', response: { answers: { q1: 'yes' } } }, 'main-thread');
  assert.equal(client.responses[0].id, 'req-1');
  status = await manager.cancel(started.taskId, 'stop now', 'main-thread');
  assert.equal(status.status, 'cancelled');
  assert.equal(client.interrupts.length, 1);
  client.finish?.({ threadId: 'worker-thread', turnId: 'worker-turn', status: 'cancelled', output: '', messages: [] });
});
