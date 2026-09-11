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
import { CodexConfigManager, CODEX_PROVIDER_ID } from '../src/codex-config.mjs';
import { ModelGateway } from '../src/gateway.mjs';
import { WorkerManager } from '../src/worker-manager.mjs';
import { probeCodexCompatibility } from '../src/provider.mjs';
import { codexParity } from '../src/codex-model-info.mjs';
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

async function writeSealMcpServer(file) {
  const source = String.raw`import fs from 'node:fs/promises';
const marker = process.argv[2] || 'missing-marker';
const logFile = process.argv[3] || '';
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
}
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const index = buffer.indexOf('\\n');
    if (index < 0) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.method === 'initialize') {
      reply(message.id, {
        protocolVersion: message.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'dwmcp-archive-seal', version: '1.0.0' }
      });
      continue;
    }
    if (message.method === 'notifications/initialized') continue;
    if (message.method === 'ping') {
      reply(message.id, {});
      continue;
    }
    if (message.method === 'tools/list') {
      reply(message.id, {
        tools: [{
          name: 'seal_ping',
          description: 'Return the archive seal marker. Call exactly once when asked.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false }
        }]
      });
      continue;
    }
    if (message.method === 'tools/call') {
      if (message.params?.name !== 'seal_ping') {
        reply(message.id, { content: [{ type: 'text', text: 'unknown tool' }], isError: true });
        continue;
      }
      if (logFile) void fs.writeFile(logFile, marker + '\\n', 'utf8');
      reply(message.id, {
        content: [{ type: 'text', text: 'MCP_SEAL:' + marker }],
        structuredContent: { marker },
        isError: false
      });
      continue;
    }
    if (message.id !== undefined) reply(message.id, {});
  }
});
`;
  await fs.writeFile(file, source, { mode: 0o700 });
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
  let model = provider.models?.find((item) => item.id === baseProfile.modelId);
  if (!model) throw new Error('configured target model is missing from live provider catalog');

  const providerApiKey = provider.apiKeyCipher ? await vault.decrypt(provider.apiKeyCipher) : '';
  const compatibilityProbe = await probeCodexCompatibility({
    provider,
    apiKey: providerApiKey,
    model: model.id
  });
  if (compatibilityProbe.ok && ['responses', 'chat'].includes(compatibilityProbe.protocol)) {
    await store.setProtocol(provider.id, model.id, compatibilityProbe.protocol);
  }
  await store.setModelProbe(provider.id, model.id, compatibilityProbe);
  model = (await store.provider(provider.id))?.models?.find((item) => item.id === baseProfile.modelId);
  const parity = codexParity(model);
  if (parity.grade !== 'full-candidate') {
    throw new Error(`archive-grade Worker parity requires native Responses + function tools + custom/freeform tools; got ${parity.grade}`);
  }

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
  if (renewalDone.compatibility?.grade !== 'full-candidate') throw new Error('Worker did not retain full-candidate compatibility at execution time');

  const patchMarker = `patch-${crypto.randomBytes(8).toString('hex')}`;
  const patchFile = path.join(fixture, 'native-patch-proof.txt');
  const patch = await manager.start({
    supervisorThreadId: sealThreadId,
    cwd: fixture,
    task: [
      'Prove native Codex apply_patch compatibility.',
      'You MUST use the native apply_patch tool directly, not a shell command, redirection, Python, sed, perl, or cat,',
      `to create native-patch-proof.txt containing exactly: ${patchMarker}`,
      'After the patch succeeds, use a read-only shell command only to verify the exact file contents, then finish.'
    ].join(' ')
  });
  startedTaskIds.push(patch.taskId);
  const patchDone = await waitTerminal(manager, patch.taskId, sealThreadId, 2 * 60 * 1000);
  if (patchDone.status !== 'completed' || !await existsWith(patchFile, patchMarker)) throw new Error('native apply_patch proof did not create the expected file');
  if (!(patchDone.events || []).some((event) => event.type === 'fileChange')) throw new Error('native apply_patch proof did not emit an official Codex fileChange event');

  const mcpMarker = `mcp-${crypto.randomBytes(8).toString('hex')}`;
  const mcpLog = path.join(fixture, 'mcp-invoked.txt');
  const mcpServer = path.join(fixture, 'archive-seal-mcp.mjs');
  await writeSealMcpServer(mcpServer);
  const mcpRouteAlias = await store.createRoute({
    providerId: provider.id,
    modelId: model.id,
    reasoning: baseProfile.reasoning || 'auto',
    capability: model.reasoning
  });
  const mcpEvents = [];
  const mcpResult = await accountClient.runThread({
    model: mcpRouteAlias,
    modelProvider: CODEX_PROVIDER_ID,
    cwd: fixture,
    sandbox: 'read-only',
    timeoutMs: 2 * 60 * 1000,
    config: {
      'mcp_servers.archive_seal': {
        command: process.execPath,
        args: [mcpServer, mcpMarker, mcpLog],
        default_tools_approval_mode: 'approve'
      }
    },
    prompt: [
      'This is an archive seal test for the official Codex MCP tool path.',
      'Call mcp__archive_seal__seal_ping exactly once.',
      `Its result must contain MCP_SEAL:${mcpMarker}.`,
      `After the tool returns, repeat exactly MCP_SEAL:${mcpMarker} in your final answer.`,
      'Do not simulate the result and do not use shell commands.'
    ].join(' '),
    developerInstructions: 'Use the configured archive_seal MCP tool exactly as requested. Do not fabricate tool output.',
    onProgress: (message) => mcpEvents.push(message)
  });
  if (!/completed/i.test(String(mcpResult.status))) throw new Error(`MCP roundtrip did not complete: ${mcpResult.status}`);
  if (!await existsWith(mcpLog, mcpMarker)) throw new Error('MCP server was not actually invoked by Codex');
  if (!mcpEvents.some((event) => JSON.stringify(event).includes('mcpToolCall'))) throw new Error('official Codex MCP tool lifecycle event was not observed');
  if (!String(mcpResult.output || '').includes(`MCP_SEAL:${mcpMarker}`)) throw new Error('third-party model did not continue from the real MCP tool result');

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
  if (compatibilityProbe.codex?.functionTools !== true || compatibilityProbe.codex?.customTools !== true) {
    throw new Error('archive-grade tool schema probes were not both successful');
  }

  const accountAfter = await accountClient.request('account/read', { refreshToken: false }, 30000);
  const accountAfterType = accountAfter?.account?.type || accountAfter?.type || null;
  const codexAfter = await codexConfig.status();
  if (accountAfterType !== 'chatgpt') throw new Error('official ChatGPT account was not preserved after Worker execution');
  if (JSON.stringify(codexBefore.selectors) !== JSON.stringify(codexAfter.selectors)) throw new Error('official top-level Codex selectors changed during target proof');

  evidence = {
    schemaVersion: 2,
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
    model: {
      id: model.id,
      reasoning: baseProfile.reasoning || 'auto',
      compatibility: parity,
      probe: {
        grade: compatibilityProbe.grade,
        functionTools: compatibilityProbe.codex?.functionTools === true,
        customTools: compatibilityProbe.codex?.customTools === true
      }
    },
    proofs: {
      realWorkerWrite: true,
      officialToolActivity: true,
      nativeApplyPatch: true,
      realMcpRoundtrip: true,
      mcpResultContinuation: true,
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
    schemaVersion: 2,
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