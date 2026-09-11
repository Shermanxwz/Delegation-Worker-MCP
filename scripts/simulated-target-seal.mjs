import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { projectRoot } from '../src/paths.mjs';
import { StateStore } from '../src/store.mjs';
import { SecretVault } from '../src/vault.mjs';
import { TaskStore } from '../src/task-store.mjs';
import { CodexConfigManager } from '../src/codex-config.mjs';
import { ModelGateway } from '../src/gateway.mjs';
import { WorkerManager } from '../src/worker-manager.mjs';
import { DelegationRuntime } from '../src/runtime.mjs';

function gitHead() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('cannot resolve candidate git SHA');
  return result.stdout.trim();
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitTerminal(runtime, taskId, threadId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await runtime.workerStatus({ taskId }, { threadId });
    if (['completed', 'failed', 'timed_out', 'cancelled', 'verification_failed', 'needs_followup'].includes(last?.status)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const diagnostic = {
    taskId,
    status: last?.status || null,
    phase: last?.phase || null,
    threadId: last?.threadId || null,
    turnId: last?.turnId || null,
    error: last?.error || null,
    verification: last?.verification || null,
    recentEvents: Array.isArray(last?.events) ? last.events.slice(-8) : []
  };
  throw new Error(`simulated Worker did not terminate: ${JSON.stringify(diagnostic)}`);
}

async function waitActive(runtime, taskId, threadId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await runtime.workerStatus({ taskId }, { threadId });
    if (task?.threadId && task?.turnId) return task;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`simulated Worker did not become active: ${taskId}`);
}

async function writeFakeCodex(file) {
  const source = String.raw`#!/usr/bin/env node
import fs from 'node:fs/promises';
import readline from 'node:readline';

const logFile = process.env.SIM_CODEX_LOG;
const gateway = process.env.DWMCP_GATEWAY_BASE_URL;
const token = process.env.DWMCP_GATEWAY_TOKEN;
const threads = new Map();
let serial = 0;

async function log(event) {
  if (!logFile) return;
  await fs.appendFile(logFile, JSON.stringify({ at: Date.now(), ...event }) + '\\n');
}
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
function result(id, value = {}) { send({ jsonrpc: '2.0', id, result: value }); }
function notify(method, params = {}) { send({ jsonrpc: '2.0', method, params }); }

await log({ event: 'spawn', argv: process.argv.slice(2), processScoped: Boolean(gateway && token) });
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  try {
    if (message.method === 'initialize') {
      return result(message.id, { platformFamily: 'unix' });
    }
    if (message.method === 'initialized') return;
    if (message.method === 'thread/start') {
      serial += 1;
      const id = 'sim-thread-' + serial;
      const sessionId = 'sim-session-' + serial;
      const route = String(message.params?.model || '');
      let catalogOk = false;
      if (gateway && token) {
        const response = await fetch(gateway + '/models', { headers: { authorization: 'Bearer ' + token } });
        const body = await response.json();
        catalogOk = response.ok && Array.isArray(body.models) && body.models.some((model) => model.slug === route);
      }
      if (!catalogOk) throw new Error('route alias was not visible through Codex-native /models');
      threads.set(id, { id, sessionId, route, cwd: message.params?.cwd || process.cwd(), status: 'idle', activeTurn: null });
      await log({ event: 'thread-start', id, sessionId, route, catalogOk, sandbox: message.params?.sandbox });
      return result(message.id, { thread: { id, sessionId, status: { type: 'idle' } } });
    }
    if (message.method === 'turn/start') {
      const thread = threads.get(message.params?.threadId);
      if (!thread) throw new Error('unknown thread');
      const prompt = String(message.params?.input?.[0]?.text || '');
      const turnId = 'sim-turn-' + Math.random().toString(36).slice(2, 9);
      thread.status = 'active';
      thread.activeTurn = turnId;
      result(message.id, { turn: { id: turnId, status: 'inProgress' } });
      await log({ event: 'turn-start', threadId: thread.id, turnId, verifier: prompt.includes('Independently verify'), long: prompt.includes('SIMULATED_LONG_TASK') });
      if (prompt.includes('SIMULATED_LONG_TASK')) return;

      const response = await fetch(gateway + '/responses', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ model: thread.route, input: prompt, stream: false })
      });
      if (!response.ok) throw new Error('gateway Responses route failed: ' + response.status);
      await response.text();
      const verifier = prompt.includes('Independently verify');
      let output = 'simulated implementation completed';
      if (verifier) {
        output = JSON.stringify({
          verdict: 'pass',
          summary: 'Simulated end-to-end verifier passed.',
          checks: ['gateway route reached', 'read-only verification thread completed'],
          findings: [],
          evidence: ['fake Codex observed a successful provider response']
        });
      } else {
        await fs.writeFile(thread.cwd + '/simulated-worker-proof.txt', 'SIMULATED_WORKER_OK\\n', 'utf8');
        notify('item/started', { threadId: thread.id, turnId, item: { type: 'commandExecution', command: 'simulated-provider-roundtrip', status: 'inProgress' } });
        notify('item/completed', { threadId: thread.id, turnId, item: { type: 'fileChange', changes: [{ path: 'simulated-worker-proof.txt' }], status: 'completed' } });
      }
      thread.status = 'idle';
      notify('turn/completed', {
        threadId: thread.id,
        turn: { id: turnId, status: 'completed', items: [{ type: 'agentMessage', text: output }] }
      });
      await log({ event: 'turn-completed', threadId: thread.id, turnId, verifier });
      return;
    }
    if (message.method === 'turn/steer') {
      await log({ event: 'turn-steer', threadId: message.params?.threadId, turnId: message.params?.expectedTurnId, text: message.params?.input?.[0]?.text || '' });
      return result(message.id, {});
    }
    if (message.method === 'turn/interrupt') {
      const thread = threads.get(message.params?.threadId);
      if (thread) {
        thread.status = 'idle';
        thread.activeTurn = null;
      }
      await log({ event: 'turn-interrupt', threadId: message.params?.threadId, turnId: message.params?.turnId });
      return result(message.id, {});
    }
    if (message.method === 'thread/read') {
      const thread = threads.get(message.params?.threadId);
      if (!thread) return result(message.id, { thread: { id: message.params?.threadId, status: { type: 'notLoaded' } } });
      return result(message.id, { thread: { id: thread.id, sessionId: thread.sessionId, status: { type: thread.status } } });
    }
    if (message.method === 'thread/unsubscribe') return result(message.id, {});
    if (message.id !== undefined) return result(message.id, {});
  } catch (error) {
    await log({ event: 'error', message: String(error?.message || error) });
    if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32099, message: String(error?.message || error) } });
  }
});
`;
  await fs.writeFile(file, source, { mode: 0o755 });
}

const candidate = gitHead();
const lock = JSON.parse(await fs.readFile(path.join(projectRoot, 'tests', 'upstream-lock.json'), 'utf8'));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dwmcp-simulated-target-'));
const dataDir = path.join(root, 'data');
const home = path.join(root, 'home');
const fixture = path.join(root, 'fixture');
await fs.mkdir(home, { recursive: true });
await fs.mkdir(fixture, { recursive: true });
const fakeCodex = path.join(root, process.platform === 'win32' ? 'codex.cmd' : 'codex');
const codexLog = path.join(root, 'codex-events.jsonl');
await writeFakeCodex(fakeCodex);

const providerRequests = [];
const providerServer = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const bodyText = Buffer.concat(chunks).toString('utf8');
  let body = {};
  try { body = bodyText ? JSON.parse(bodyText) : {}; } catch {}
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      object: 'list',
      data: [{
        id: 'sim-model',
        name: 'Simulated Full Worker',
        owned_by: 'seal',
        capabilities: {
          supports_function_calling: true,
          supports_custom_tools: true,
          supports_parallel_tool_calls: true,
          context_window: 131072,
          input_modalities: ['text']
        }
      }]
    }));
  }
  if (req.method === 'POST' && req.url === '/v1/responses') {
    providerRequests.push({
      model: body.model,
      toolType: body.tools?.[0]?.type || null,
      authorization: req.headers.authorization || null,
      input: typeof body.input === 'string' ? body.input.slice(0, 120) : null
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      id: 'resp_simulated',
      object: 'response',
      status: 'completed',
      model: body.model,
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SIMULATED_PROVIDER_OK' }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    }));
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});
await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
const providerPort = providerServer.address().port;
const gatewayPort = await freePort();
const env = {
  ...process.env,
  HOME: home,
  CODEX_BIN: fakeCodex,
  DWMCP_DATA_DIR: dataDir,
  DWMCP_GATEWAY_PORT: String(gatewayPort),
  SIM_CODEX_LOG: codexLog
};

const store = new StateStore({ env });
const vault = new SecretVault({ env });
const taskStore = new TaskStore({ env });
const codexConfig = new CodexConfigManager({ env });
const gateway = new ModelGateway({ store, vault, env });
const workers = new WorkerManager({ store, taskStore, codexConfig, env });
const runtime = new DelegationRuntime({ store, vault, workerManager: workers, codexConfig, gateway });
const threadId = 'simulated-supervisor-thread';
let evidence;

try {
  await workers.initialize();
  const saved = await runtime.saveProvider({
    name: 'Simulated Provider',
    baseUrl: `http://127.0.0.1:${providerPort}/v1`,
    apiKey: 'simulated-secret',
    adapter: 'openai-compatible'
  });
  if (!saved.tested || !saved.provider?.id) throw new Error('simulated provider catalog did not refresh');

  const probe = await runtime.probeProvider(saved.provider.id, 'sim-model');
  if (probe.grade !== 'full-candidate') throw new Error(`simulated provider compatibility was not full-candidate: ${probe.grade}`);

  await runtime.setProfile({
    providerId: saved.provider.id,
    modelId: 'sim-model',
    reasoning: 'auto',
    access: 'workspace-write',
    autoVerify: true,
    autoExtend: true,
    leaseMs: 60000,
    maxTotalMs: 120000
  }, { threadId });
  await runtime.setMode({ mode: 'WORKER' }, { threadId });
  const codex = await runtime.codexInstall();
  if (!codex.processScoped || codex.legacyInstalled) throw new Error('simulated target did not use process-scoped Codex provider configuration');

  const started = await runtime.workerStart({
    task: 'Create the simulated Worker proof using the complete runtime chain.',
    cwd: fixture
  }, { threadId });
  const completed = await waitTerminal(runtime, started.taskId, threadId);
  if (completed.status !== 'completed') throw new Error(`simulated implementation did not complete: status=${completed.status} error=${JSON.stringify(completed.error || null)} phase=${completed.phase || ''}`);
  if (completed.verification?.verdict !== 'pass') throw new Error('simulated verifier did not pass');
  if (!completed.sessionId) throw new Error('simulated Worker sessionId was not captured');
  const proofFile = (await fs.readFile(path.join(fixture, 'simulated-worker-proof.txt'), 'utf8')).trim();
  if (proofFile !== 'SIMULATED_WORKER_OK') throw new Error('simulated Worker proof file mismatch');

  const longTask = await runtime.workerStart({
    task: 'SIMULATED_LONG_TASK keep the turn active for steering and authoritative cancellation.',
    cwd: fixture
  }, { threadId });
  const active = await waitActive(runtime, longTask.taskId, threadId);
  await runtime.workerSteer({ taskId: longTask.taskId, direction: 'Simulated supervisor direction.' }, { threadId });
  const cancelled = await runtime.workerCancel({ taskId: longTask.taskId, reason: 'simulated authoritative cancellation' }, { threadId });
  if (cancelled.status !== 'cancelled' || cancelled.cancellation?.state !== 'confirmed') {
    throw new Error('simulated authoritative cancellation was not confirmed');
  }

  const codexEvents = (await fs.readFile(codexLog, 'utf8'))
    .trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const spawnEvent = codexEvents.find((event) => event.event === 'spawn');
  const routeEvent = codexEvents.find((event) => event.event === 'thread-start' && event.catalogOk === true);
  const steerEvent = codexEvents.find((event) => event.event === 'turn-steer');
  const interruptEvent = codexEvents.find((event) => event.event === 'turn-interrupt');
  if (!spawnEvent?.processScoped || !spawnEvent.argv.includes('--config')) throw new Error('fake Codex did not receive process-scoped --config');
  if (!routeEvent) throw new Error('fake Codex did not resolve an opaque Worker alias through gateway /models');
  if (!steerEvent || !interruptEvent) throw new Error('simulated steer/interrupt RPC path was not observed');

  const routed = providerRequests.some((request) => request.model === 'sim-model' && request.input);
  const functionProbe = providerRequests.some((request) => request.toolType === 'function');
  const customProbe = providerRequests.some((request) => request.toolType === 'custom');
  const authObserved = providerRequests.some((request) => request.authorization === 'Bearer simulated-secret');
  if (!routed || !functionProbe || !customProbe || !authObserved) {
    throw new Error('simulated provider did not observe the complete routed/probed/authenticated request matrix');
  }

  evidence = {
    schemaVersion: 1,
    kind: 'SIMULATED_TARGET_SEAL',
    eligible: true,
    status: 'SIMULATED_TARGET_SEALED',
    realTargetSubstitute: false,
    candidate,
    upstream: {
      repository: lock.repository,
      release: lock.release,
      tag: lock.tag,
      commit: lock.commit,
      expectedRuntimeVersion: lock.expectedRuntimeVersion
    },
    proofs: {
      processScopedCodexProvider: true,
      encryptedProviderCredentialRoundtrip: true,
      providerCatalogDiscovery: true,
      responsesFunctionProbe: true,
      responsesCustomProbe: true,
      codexNativeModelCatalogRoute: true,
      opaqueAliasToRealProviderModel: true,
      providerAuthorization: true,
      officialAppServerRpcShape: true,
      workerSessionIdentity: true,
      workerFileEvidence: true,
      structuredVerifierPass: true,
      supervisorSteer: true,
      authoritativeInterruptConfirmation: true
    },
    generatedAt: new Date().toISOString()
  };
} catch (error) {
  evidence = {
    schemaVersion: 1,
    kind: 'SIMULATED_TARGET_SEAL',
    eligible: false,
    status: 'SIMULATED_TARGET_FAILED',
    realTargetSubstitute: false,
    candidate,
    upstream: { repository: lock.repository, release: lock.release, tag: lock.tag, commit: lock.commit },
    error: { message: String(error?.message || error), code: error?.code || null },
    generatedAt: new Date().toISOString()
  };
} finally {
  await workers.close().catch(() => {});
  await gateway.close().catch(() => {});
  await new Promise((resolve) => providerServer.close(() => resolve()));
}

const sealDir = path.join(projectRoot, '.seal');
await fs.mkdir(sealDir, { recursive: true, mode: 0o700 });
await fs.writeFile(path.join(sealDir, 'simulated-target.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
if (!evidence.eligible) {
  console.error(`SIMULATED_TARGET_FAILED: ${evidence.error?.message || 'unknown failure'}`);
  process.exit(1);
}
console.log(`SIMULATED_TARGET_SEALED candidate=${candidate} proofs=${Object.keys(evidence.proofs).length}`);
