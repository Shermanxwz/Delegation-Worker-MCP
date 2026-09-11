import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/store.mjs';
import { TaskStore } from '../src/task-store.mjs';
import { WorkerManager } from '../src/worker-manager.mjs';

const reasoning = {
  kind: 'toggle',
  advertised: true,
  source: 'upstream_metadata',
  requestStyle: 'thinking_flag',
  options: [{ value: 'auto', label: 'Auto' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }],
  default: 'auto'
};

function codexConfig(env) {
  return {
    status: async () => ({ installed: true, processScoped: true }),
    runtimeEnv: (token, extra = {}) => ({
      ...env,
      ...extra,
      DWMCP_GATEWAY_TOKEN: token,
      DWMCP_GATEWAY_BASE_URL: 'http://127.0.0.1:8791/v1'
    })
  };
}

async function configured({ autoVerify = true } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dwmcp-worker-'));
  const env = { ...process.env, DWMCP_DATA_DIR: dir };
  const store = new StateStore({ env });
  const taskStore = new TaskStore({ env });
  const provider = await store.saveProvider({ name: 'P', baseUrl: 'https://example.com/v1', adapter: 'openai-compatible' });
  await store.setProviderModels(provider.id, [{
    id: 'mini',
    name: 'Mini',
    reasoning,
    codex: { source: 'unknown', functionTools: null, customTools: null, mcpTools: null, inputModalities: [] },
    probe: {
      ok: true,
      protocol: 'responses',
      grade: 'full-candidate',
      probedAt: new Date().toISOString(),
      codex: { functionTools: true, customTools: true, mcpTools: true, parallelToolCalls: null }
    }
  }]);
  await store.setProfile({
    providerId: provider.id,
    modelId: 'mini',
    reasoning: 'on',
    access: 'danger-full-access',
    autoVerify
  }, 'main-thread');
  await store.setSessionMode('main-thread', 'WORKER');
  return { dir, env, store, taskStore, provider };
}

function passVerdict() {
  return JSON.stringify({
    verdict: 'pass',
    summary: 'Implementation satisfies the task.',
    checks: ['inspected files', 'ran read-only checks'],
    findings: [],
    evidence: ['all requested behavior present']
  });
}

class CompletingClient {
  constructor({ verifier = passVerdict() } = {}) { this.verifier = verifier; }
  setServerRequestHandler(handler) { this.serverRequestHandler = handler; }
  async start() { return this; }
  async runThread(opts) {
    const verify = opts.sandbox === 'read-only';
    opts.onProgress?.({ method: 'thread/started', params: { threadId: verify ? 'verify-thread' : 'worker-thread', sessionId: verify ? 'verify-session' : 'worker-session' } });
    opts.onProgress?.({ method: 'turn/started', params: { threadId: verify ? 'verify-thread' : 'worker-thread', turn: { id: verify ? 'verify-turn' : 'worker-turn' } } });
    opts.onProgress?.({ method: 'turn/plan/updated', params: { threadId: verify ? 'verify-thread' : 'worker-thread', explanation: 'execute safely', plan: [{ step: 'inspect', status: 'completed' }, { step: 'implement', status: 'in_progress' }] } });
    return {
      threadId: verify ? 'verify-thread' : 'worker-thread',
      sessionId: verify ? 'verify-session' : 'worker-session',
      turnId: verify ? 'verify-turn' : 'worker-turn',
      status: 'completed',
      output: verify ? this.verifier : 'implementation ok',
      messages: []
    };
  }
  rejectAllServerRequests() {}
  async close() {}
  async steer() {}
  async interruptAndConfirm() { return { confirmed: true, threadStatus: { type: 'idle' } }; }
}

test('Worker completion requires a passing structured read-only verifier', async () => {
  const { env, store, taskStore } = await configured();
  const manager = new WorkerManager({
    store, taskStore, env, codexConfig: codexConfig(env),
    clientFactory: () => new CompletingClient()
  });
  await assert.rejects(() => manager.start({ task: 'Do work', cwd: '/tmp', supervisorThreadId: 'other-thread' }), /NATIVE mode/);
  const started = await manager.start({ task: 'Do work', cwd: '/tmp', supervisorThreadId: 'main-thread' });
  const done = await manager.wait(started.taskId, 3000, 'main-thread');
  assert.equal(done.status, 'completed');
  assert.equal(done.model.id, 'mini');
  assert.equal(done.reasoning, 'on');
  assert.equal(done.access, 'danger-full-access');
  assert.equal(done.compatibility.grade, 'full-candidate');
  assert.equal(done.compatibility.applyPatch, true);
  assert.equal(done.backend, 'official-thread-start');
  assert.equal(done.supervisorThreadId, 'main-thread');
  assert.equal(done.sessionId, 'worker-session');
  assert.equal(done.plan.steps[1].step, 'implement');
  assert.equal(done.verification.verdict, 'pass');
  assert.match(done.verification.summary, /satisfies/);
  await assert.rejects(() => manager.status(started.taskId, 'other-thread'), /different supervisor session/);
});

test('verifier fail and inconclusive states cannot be reported as completed', async () => {
  for (const [verdict, expected] of [['fail', 'verification_failed'], ['inconclusive', 'needs_followup']]) {
    const { env, store, taskStore } = await configured();
    const output = JSON.stringify({
      verdict,
      summary: verdict === 'fail' ? 'Regression found.' : 'Environment could not prove the result.',
      checks: ['read-only inspection'],
      findings: verdict === 'fail' ? ['required behavior missing'] : ['dependency unavailable'],
      evidence: []
    });
    const manager = new WorkerManager({
      store, taskStore, env, codexConfig: codexConfig(env),
      clientFactory: () => new CompletingClient({ verifier: output })
    });
    const started = await manager.start({ task: 'Do work', cwd: '/tmp', supervisorThreadId: 'main-thread' });
    const done = await manager.wait(started.taskId, 3000, 'main-thread');
    assert.equal(done.status, expected);
    assert.equal(done.verification.verdict, verdict);
  }
});

test('unparseable verifier output becomes needs_followup rather than completed', async () => {
  const { env, store, taskStore } = await configured();
  const manager = new WorkerManager({
    store, taskStore, env, codexConfig: codexConfig(env),
    clientFactory: () => new CompletingClient({ verifier: 'looks okay to me' })
  });
  const started = await manager.start({ task: 'Do work', cwd: '/tmp', supervisorThreadId: 'main-thread' });
  const done = await manager.wait(started.taskId, 3000, 'main-thread');
  assert.equal(done.status, 'needs_followup');
  assert.equal(done.verification.verdict, 'inconclusive');
});

class ControlledClient {
  constructor({ cancelError = null } = {}) {
    this.cancelError = cancelError;
    this.steers = [];
    this.interrupts = [];
    this.responses = [];
    this.rejects = [];
  }
  setServerRequestHandler(handler) { this.serverRequestHandler = handler; }
  async start() { return this; }
  runThread(opts) {
    this.opts = opts;
    opts.onProgress?.({ method: 'thread/started', params: { threadId: 'worker-thread', sessionId: 'worker-session' } });
    opts.onProgress?.({ method: 'turn/started', params: { threadId: 'worker-thread', turn: { id: 'worker-turn' } } });
    opts.onProgress?.({ method: 'item/started', params: { threadId: 'worker-thread', turnId: 'worker-turn', item: { type: 'commandExecution', command: 'npm test', status: 'inProgress' } } });
    return new Promise((resolve) => { this.finish = resolve; });
  }
  async steer(threadId, turnId, text) { this.steers.push({ threadId, turnId, text }); }
  async interruptAndConfirm(threadId, turnId) {
    this.interrupts.push({ threadId, turnId });
    if (this.cancelError) throw this.cancelError;
    return { confirmed: true, threadId, turnId, threadStatus: { type: 'idle' } };
  }
  respondServerRequest(id, response) { this.responses.push({ id, response }); return { responded: true, requestId: id }; }
  rejectServerRequest(id, reason) { this.rejects.push({ id, reason }); return { rejected: true, requestId: id }; }
  rejectAllServerRequests() {}
  async close() {}
}

async function waitForTurn(manager, taskId) {
  for (let i = 0; i < 50; i += 1) {
    const status = await manager.status(taskId, 'main-thread');
    if (status?.turnId) return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('turn did not start');
}

test('supervisor can observe, steer, renew, resolve concurrent Codex requests and cancel with official proof', async () => {
  const { env, store, taskStore } = await configured({ autoVerify: false });
  let client;
  const manager = new WorkerManager({
    store, taskStore, env, codexConfig: codexConfig(env),
    clientFactory: () => (client = new ControlledClient())
  });
  const started = await manager.start({ task: 'Long work', cwd: '/tmp', supervisorThreadId: 'main-thread' });
  let status = await waitForTurn(manager, started.taskId);
  assert.equal(status.latestAction.type, 'commandExecution');
  assert.equal(status.progressEvidence.state, 'progressing');
  assert.ok(status.progressEvidence.controllerLivenessAgeMs >= 0);
  assert.ok(status.progressEvidence.runtimeEventAgeMs >= 0);

  const beforeDeadline = Date.parse(status.supervision.leaseDeadlineAt);
  await manager.steer(started.taskId, 'Focus on tests', 'main-thread');
  assert.equal(client.steers.length, 1);
  status = await manager.extend(started.taskId, { extraMs: 10000, reason: 'healthy progress' }, 'main-thread');
  assert.ok(Date.parse(status.supervision.leaseDeadlineAt) > beforeDeadline);

  client.serverRequestHandler({ id: 'req-1', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'q1', question: 'continue?' }] }, receivedAt: new Date().toISOString() });
  client.serverRequestHandler({ id: 'req-2', method: 'mcpServer/elicitation/request', params: { message: 'second' }, receivedAt: new Date().toISOString() });
  await new Promise((resolve) => setTimeout(resolve, 20));

  status = await manager.status(started.taskId, 'main-thread');
  assert.deepEqual(status.pendingInteractions.map((entry) => entry.requestId), ['req-1', 'req-2']);
  assert.equal(status.pendingInteraction.requestId, 'req-1');

  await manager.respond(started.taskId, { requestId: 'req-2', response: { action: 'accept' } }, 'main-thread');
  assert.equal(client.responses[0].id, 'req-2');
  status = await manager.status(started.taskId, 'main-thread');
  assert.deepEqual(status.pendingInteractions.map((entry) => entry.requestId), ['req-1']);

  await manager.respond(started.taskId, { requestId: 'req-1', response: { answers: { q1: 'yes' } } }, 'main-thread');
  assert.equal(client.responses[1].id, 'req-1');

  status = await manager.cancel(started.taskId, 'stop now', 'main-thread');
  assert.equal(status.status, 'cancelled');
  assert.equal(status.cancellation.state, 'confirmed');
  assert.equal(status.cancellation.proof.confirmed, true);
  assert.equal(client.interrupts.length, 1);
  client.finish?.({ threadId: 'worker-thread', sessionId: 'worker-session', turnId: 'worker-turn', status: 'cancelled', output: '', messages: [] });
});

test('failed official interrupt never produces a false cancelled state', async () => {
  const { env, store, taskStore } = await configured({ autoVerify: false });
  let client;
  const failure = Object.assign(new Error('interrupt rejected by official runtime'), { code: 'INTERRUPT_REJECTED' });
  const manager = new WorkerManager({
    store, taskStore, env, codexConfig: codexConfig(env),
    clientFactory: () => (client = new ControlledClient({ cancelError: failure }))
  });
  const started = await manager.start({ task: 'Long work', cwd: '/tmp', supervisorThreadId: 'main-thread' });
  await waitForTurn(manager, started.taskId);
  await assert.rejects(() => manager.cancel(started.taskId, 'stop now', 'main-thread'), /interrupt rejected/);
  const status = await manager.status(started.taskId, 'main-thread');
  assert.equal(status.status, 'running');
  assert.equal(status.cancellation.state, 'failed');
  assert.equal(status.cancellation.error.code, 'INTERRUPT_REJECTED');
  assert.equal(client.interrupts.length, 1);
  client.finish?.({ threadId: 'worker-thread', sessionId: 'worker-session', turnId: 'worker-turn', status: 'completed', output: 'done', messages: [] });
  const done = await manager.wait(started.taskId, 1000, 'main-thread');
  assert.equal(done.status, 'completed');
});
