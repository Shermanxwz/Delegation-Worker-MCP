import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite } from '../src/atomic.mjs';
import { projectRoot, statePath } from '../src/paths.mjs';
import { StateStore } from '../src/store.mjs';
import { SecretVault } from '../src/vault.mjs';
import { TaskStore } from '../src/task-store.mjs';
import { CodexConfigManager } from '../src/codex-config.mjs';
import { ModelGateway } from '../src/gateway.mjs';
import { WorkerManager } from '../src/worker-manager.mjs';
import { CodexAppServerClient, resolveCodexBinary } from '../src/app-server.mjs';

const TERMINAL = new Set(['completed', 'failed', 'timed_out', 'cancelled']);

function gitHead() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('cannot resolve candidate git SHA');
  return result.stdout.trim();
}
function codexVersion(binary) {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', env: process.env });
  return result.status === 0 ? result.stdout.trim() : null;
}
async function waitFor(manager, taskId, supervisorThreadId, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await manager.status(taskId, supervisorThreadId);
    if (predicate(task)) return task;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for task ${taskId}`);
}
async function waitTerminal(manager, taskId, supervisorThreadId, timeoutMs = 10 * 60 * 1000) {
  return waitFor(manager, taskId, supervisorThreadId, (task) => TERMINAL.has(task?.status), timeoutMs);
}
async function existsWith(file, expected) {
  try { return (await fs.readFile(file, 'utf8')).trim() === expected; } catch { return false; }
}

if (process.env.CI && process.env.DWMCP_ALLOW_CI_TARGET_SEAL !== '1') {
  throw new Error('TARGET_SEALED must run on a real signed-in Codex host, not ordinary hosted CI');
}

const candidate = gitHead();
const lock = JSON.parse(await fs.readFile(path.join(projectRoot, 'tests', 'upstream-lock.json'), 'utf8'));
const stateFile = statePath(process.env);
let originalState = null;
let stateExisted = true;
try { originalState = await fs.readFile(stateFile); } catch (error) { if (error.code === 'ENOENT') stateExisted = false; else throw error; }

const store = new StateStore();
const vault = new SecretVault();
const taskStore = new TaskStore();
const codexConfig = new CodexConfigManager();
const gateway = new ModelGateway({ store, vault });
const manager = new WorkerManager({ store, taskStore, codexConfig });
const sealThreadId = `seal-${crypto.randomBytes(8).toString('hex')}`;
const startedTaskIds = [];
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'delegation-worker-seal-'));
let accountClient;
let evidence;

try {
  const snapshot = await store.read();
  const configuredSession = Object.values(snapshot.sessions || {}).find((session) =>
    session?.mode === 'WORKER' && session?.profile?.providerId && session?.profile?.modelId
  );
  const baseProfile = configuredSession?.profile || snapshot.defaultProfile;
  if (!baseProfile?.providerId || !baseProfile?.modelId) throw new Error('configure a real third-party Worker provider/model before target sealing');
  const provider = await store.provider(baseProfile.providerId);
  if (!provider) throw new Error('configured target provider is missing');
  const model = provider.models?.find((item) => item.id === baseProfile.modelId);
  if (!model) throw new Error('configured target model is missing from live provider catalog');

  const codexBefore = await codexConfig.status();
  if (!codexBefore.installed) throw new Error('run Connect Codex in the Worker panel before target sealing');
  await gateway.start();

  const binary = resolveCodexBinary(process.env);
  accountClient = new CodexAppServerClient({ binary });
  await accountClient.start();
  const accountBefore = await accountClient.request('account/read', { refreshToken: false }, 30000);
  const accountType = accountBefore?.account?.type || accountBefore?.type || null;
  if (accountType !== 'chatgpt') throw new Error(`official ChatGPT account proof failed: account type is ${accountType || 'unknown'}`);

  await store.setProfile({
    ...baseProfile,
    access: 'danger-full-access',
    autoVerify: true,
    autoExtend: true,
    leaseMs: 60_000,
    maxTotalMs: 3 * 60_000
  }, sealThreadId);
  await store.setSessionMode(sealThreadId, 'WORKER');

  const renewalMarker = `renewal-${crypto.randomBytes(8).toString('hex')}`;
  const renewalFile = path.join(fixture, 'renewal-proof.txt');
  const renewal = await manager.start({
    supervisorThreadId: sealThreadId,
    cwd: fixture,
    task: [
      'This is a real Codex Worker seal test.',
      'Use the official Codex shell/tool surface. Run the shell command: sleep 70.',
      `After the sleep completes, create renewal-proof.txt containing exactly: ${renewalMarker}`,
      'Then verify the file and finish. Do not skip the sleep.'
    ].join(' ')
  });
  startedTaskIds.push(renewal.taskId);
  const renewalDone = await waitTerminal(manager, renewal.taskId, sealThreadId, 4 * 60 * 1000);
  if (renewalDone.status !== 'completed') throw new Error(`renewal proof did not complete: ${renewalDone.status}`);
  if (!await existsWith(renewalFile, renewalMarker)) throw new Error('real Worker did not write the renewal proof file');
  if ((renewalDone.supervision?.autoExtensionCount || 0) < 1) throw new Error('bounded automatic renewal was not observed');
  if (!renewalDone.verification) throw new Error('independent read-only verifier evidence is missing');
  const toolEvidence = (renewalDone.events || []).some((event) => ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(event.type));
  if (!toolEvidence) throw new Error('no official Codex tool activity was observed');

  const steerMarker = `steer-${crypto.randomBytes(8).toString('hex')}`;
  const steerFile = path.join(fixture, 'steered-proof.txt');
  const steer = await manager.start({
    supervisorThreadId: sealThreadId,
    cwd: fixture,
    task: 'Inspect the workspace, then run the shell command sleep 30 before finalizing. Keep the turn active long enough to receive supervisor steering.'
  });
  startedTaskIds.push(steer.taskId);
  await waitFor(manager, steer.taskId, sealThreadId, (task) => Boolean(task?.threadId && task?.turnId), 30_000);
  await manager.steer(steer.taskId, `After the current step, create steered-proof.txt containing exactly: ${steerMarker}. Verify it before finishing.`, sealThreadId);
  const steerDone = await waitTerminal(manager, steer.taskId, sealThreadId, 2 * 60 * 1000);
  if (steerDone.status !== 'completed' || !await existsWith(steerFile, steerMarker)) throw new Error('official turn/steer proof failed');

  const cancel = await manager.start({
    supervisorThreadId: sealThreadId,
    cwd: fixture,
    task: 'Run the shell command sleep 120 and do not finish the task before that command completes.'
  });
  startedTaskIds.push(cancel.taskId);
  await waitFor(manager, cancel.taskId, sealThreadId, (task) => Boolean(task?.threadId && task?.turnId), 30_000);
  await manager.cancel(cancel.taskId, 'target seal cancellation proof', sealThreadId);
  const cancelDone = await waitTerminal(manager, cancel.taskId, sealThreadId, 30_000);
  if (cancelDone.status !== 'cancelled') throw new Error('official turn/interrupt cancellation proof failed');

  const detectedProtocol = (await store.protocol(provider.id, model.id))?.protocol || provider.protocol || 'auto';
  if (detectedProtocol !== 'responses') throw new Error(`archive-grade native tool parity requires Responses transport; detected ${detectedProtocol}`);

  const accountAfter = await accountClient.request('account/read', { refreshToken: false }, 30000);
  const accountAfterType = accountAfter?.account?.type || accountAfter?.type || null;
  const codexAfter = await codexConfig.status();
  if (accountAfterType !== 'chatgpt') throw new Error('official ChatGPT account was not preserved after Worker execution');
  if (JSON.stringify(codexBefore.selectors) !== JSON.stringify(codexAfter.selectors)) throw new Error('official top-level Codex selectors changed during target proof');

  evidence = {
    schemaVersion: 1,
    kind: 'TARGET_SEAL',
    eligible: true,
    status: 'TARGET_SEALED',
    candidate,
    upstream: { repository: lock.repository, commit: lock.commit },
    host: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      codex: codexVersion(binary),
      accountType: accountAfterType
    },
    provider: { id: provider.id, name: provider.name, protocol: detectedProtocol },
    model: { id: model.id, reasoning: baseProfile.reasoning || 'auto' },
    proofs: {
      realWorkerWrite: true,
      officialToolActivity: true,
      automaticBoundedRenewal: true,
      readOnlyVerifier: true,
      officialSteer: true,
      officialInterrupt: true,
      officialAccountPreserved: true,
      officialTopLevelSelectorsPreserved: true
    },
    generatedAt: new Date().toISOString()
  };
} catch (error) {
  evidence = {
    schemaVersion: 1,
    kind: 'TARGET_SEAL',
    eligible: false,
    status: 'TARGET_FAILED',
    candidate,
    upstream: { repository: lock.repository, commit: lock.commit },
    error: { message: String(error?.message || error), code: error?.code || null },
    generatedAt: new Date().toISOString()
  };
} finally {
  for (const taskId of startedTaskIds) await manager.cancel(taskId, 'target seal cleanup', sealThreadId).catch(() => {});
  await accountClient?.close().catch(() => {});
  await gateway.close().catch(() => {});
  if (stateExisted) await atomicWrite(stateFile, originalState, { mode: 0o600 });
  else await fs.rm(stateFile, { force: true });
}

const sealDir = path.join(projectRoot, '.seal');
await fs.mkdir(sealDir, { recursive: true, mode: 0o700 });
await fs.writeFile(path.join(sealDir, 'target.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
if (!evidence.eligible) {
  console.error(`TARGET_FAILED: ${evidence.error?.message || 'unknown failure'}`);
  process.exit(1);
}
console.log(`TARGET_SEALED candidate=${candidate} provider=${evidence.provider.id} model=${evidence.model.id}`);
