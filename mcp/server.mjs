#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from '../src/paths.mjs';
import { SecretVault } from '../src/vault.mjs';
import { StateStore } from '../src/store.mjs';
import { TaskStore } from '../src/task-store.mjs';
import { CodexConfigManager } from '../src/codex-config.mjs';
import { WorkerManager } from '../src/worker-manager.mjs';
import { ModelGateway } from '../src/gateway.mjs';
import { DelegationRuntime } from '../src/runtime.mjs';

const APP_URI = 'ui://delegation-worker/control';
const APP_MIME = 'text/html;profile=mcp-app';
const MAX_LINE = 2 * 1024 * 1024;
const childMode = process.env.DWMCP_WORKER_CHILD === '1';

const store = new StateStore();
const vault = new SecretVault();
const taskStore = new TaskStore();
const codexConfig = new CodexConfigManager();
const gateway = new ModelGateway({ store, vault });
const workers = new WorkerManager({ store, taskStore, codexConfig });
const runtime = new DelegationRuntime({ store, vault, workerManager: workers, codexConfig, gateway });

await workers.initialize();
await gateway.start().catch((error) => {
  process.stderr.write(`delegation-worker-mcp: gateway unavailable: ${error.message}\n`);
});

function schema(properties = {}, required = []) {
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
}
const APP_ONLY = { ui: { visibility: ['app'] } };
const APP_RESOURCE = { ui: { resourceUri: APP_URI } };
const READ_ONLY = { readOnlyHint: true, destructiveHint: false };
const MUTATING = { readOnlyHint: false };

function contextFrom(params = {}) {
  const meta = params?._meta && typeof params._meta === 'object' ? params._meta : {};
  const id = String(meta.threadId || meta.thread_id || '').slice(0, 256);
  return {
    threadId: id,
    itemId: String(meta.itemId || meta.item_id || '').slice(0, 256) || null,
    callId: String(meta.callId || meta.call_id || '').slice(0, 256) || null
  };
}

function tools() {
  const common = [
    {
      name: 'worker_panel', title: 'Worker',
      description: 'Open the Delegation Worker control panel for the current host session.',
      inputSchema: schema(), _meta: APP_RESOURCE, annotations: READ_ONLY
    },
    {
      name: 'delegation_status',
      description: 'Read current session mode, redacted Worker profile, active Worker progress and Codex connection status. NATIVE means Delegation Worker is dormant for this session.',
      inputSchema: schema(), annotations: READ_ONLY
    },
    {
      name: 'session_mode_get',
      description: 'Read whether the current session is NATIVE or WORKER mode.',
      inputSchema: schema(), annotations: READ_ONLY
    },
    {
      name: 'worker_catalog',
      description: 'Read configured providers, discovered models, and explicitly advertised per-model reasoning controls. Secrets are never returned.',
      inputSchema: schema({ refresh: { type: 'boolean' } }), annotations: READ_ONLY
    },
    {
      name: 'worker_profile_get',
      description: 'Read the operator-selected Worker model, reasoning, access and supervision settings for the current session.',
      inputSchema: schema(), annotations: READ_ONLY
    },
    {
      name: 'worker_status',
      description: 'Read a Worker task including current phase, plan, latest action, heartbeat/progress evidence, lease, pending Codex interaction, verifier and result.',
      inputSchema: schema({ taskId: { type: 'string', minLength: 8, maxLength: 128 } }, ['taskId']),
      annotations: READ_ONLY
    },
    {
      name: 'worker_wait',
      description: 'Wait for a Worker task to finish or until the bounded wait window elapses.',
      inputSchema: schema({
        taskId: { type: 'string', minLength: 8, maxLength: 128 },
        waitMs: { type: 'number', minimum: 0, maximum: 170000 }
      }, ['taskId']), annotations: READ_ONLY
    },
    {
      name: 'worker_cancel',
      description: 'Immediately interrupt and cancel an active Worker owned by the current supervisor session.',
      inputSchema: schema({
        taskId: { type: 'string', minLength: 8, maxLength: 128 },
        reason: { type: 'string', maxLength: 500 }
      }, ['taskId']), annotations: MUTATING
    }
  ];

  if (!childMode) {
    common.splice(5, 0,
      {
        name: 'worker_start',
        description: 'Start the operator-configured Worker for this session. Provider, model, reasoning, access and renewal policy are intentionally not arguments; the human Worker panel owns them.',
        inputSchema: schema({
          task: { type: 'string', minLength: 1, maxLength: 524288 },
          cwd: { type: 'string', maxLength: 4096 }
        }, ['task']), annotations: MUTATING
      },
      {
        name: 'worker_steer',
        description: 'Give an active Worker a precise direction change through official Codex turn/steer.',
        inputSchema: schema({
          taskId: { type: 'string', minLength: 8, maxLength: 128 },
          direction: { type: 'string', minLength: 1, maxLength: 32768 }
        }, ['taskId', 'direction']), annotations: MUTATING
      },
      {
        name: 'worker_extend',
        description: 'Manually renew an active Worker lease within the operator-configured hard runtime limit. Automatic bounded renewal is enabled by default.',
        inputSchema: schema({
          taskId: { type: 'string', minLength: 8, maxLength: 128 },
          extraMs: { type: 'number', minimum: 1000, maximum: 900000 },
          reason: { type: 'string', maxLength: 500 }
        }, ['taskId']), annotations: MUTATING
      },
      {
        name: 'worker_respond',
        description: 'Answer or reject a pending official Codex server request surfaced by worker_status. Pass the exact pending requestId and the official response object expected by that request.',
        inputSchema: schema({
          taskId: { type: 'string', minLength: 8, maxLength: 128 },
          requestId: { type: 'string', minLength: 1, maxLength: 256 },
          response: { type: 'object' },
          reject: { type: 'boolean' },
          reason: { type: 'string', maxLength: 1000 }
        }, ['taskId']), annotations: MUTATING
      }
    );

    common.push(
      {
        name: 'session_mode_set',
        description: 'Set NATIVE or WORKER mode for the current session. Switching to NATIVE cancels active Workers for this session.',
        inputSchema: schema({ mode: { type: 'string', enum: ['NATIVE', 'WORKER'] } }, ['mode']),
        _meta: APP_ONLY, annotations: MUTATING
      },
      {
        name: 'provider_save',
        description: 'Create/update a provider profile and test its model catalog. API keys are encrypted locally and never returned.',
        inputSchema: schema({
          id: { type: 'string' }, name: { type: 'string', minLength: 1, maxLength: 120 },
          baseUrl: { type: 'string', minLength: 1, maxLength: 2048 },
          apiKey: { type: 'string', maxLength: 16384 },
          adapter: { type: 'string', enum: ['openai-compatible'] },
          authType: { type: 'string', enum: ['bearer', 'header'] },
          headerName: { type: 'string', maxLength: 64 }
        }, ['name', 'baseUrl']), _meta: APP_ONLY, annotations: MUTATING
      },
      {
        name: 'provider_delete',
        description: 'Delete a provider profile and its encrypted credential reference.',
        inputSchema: schema({ id: { type: 'string', minLength: 3, maxLength: 80 } }, ['id']),
        _meta: APP_ONLY, annotations: MUTATING
      },
      {
        name: 'provider_refresh',
        description: 'Refresh one provider model catalog and explicit reasoning metadata.',
        inputSchema: schema({ id: { type: 'string', minLength: 3, maxLength: 80 } }, ['id']),
        _meta: APP_ONLY, annotations: READ_ONLY
      },
      {
        name: 'provider_probe',
        description: 'Probe whether a configured provider/model accepts Responses or requires Chat Completions compatibility.',
        inputSchema: schema({ id: { type: 'string' }, modelId: { type: 'string' } }, ['id']),
        _meta: APP_ONLY, annotations: READ_ONLY
      },
      {
        name: 'provider_model_override',
        description: 'Advanced operator override for reasoning capability when upstream metadata is absent. Provenance remains operator_override.',
        inputSchema: schema({
          providerId: { type: 'string' }, modelId: { type: 'string' },
          override: { type: ['object', 'null'] }
        }, ['providerId', 'modelId']), _meta: APP_ONLY, annotations: MUTATING
      },
      {
        name: 'worker_profile_set',
        description: 'Save the human-selected Worker provider/model/reasoning/access settings for the current session.',
        inputSchema: schema({
          providerId: { type: 'string' }, modelId: { type: 'string' }, reasoning: { type: 'string' },
          access: { type: 'string', enum: ['danger-full-access', 'workspace-write', 'read-only'] },
          autoVerify: { type: 'boolean' }, autoExtend: { type: 'boolean' },
          leaseMs: { type: 'number', minimum: 60000, maximum: 3600000 },
          maxTotalMs: { type: 'number', minimum: 60000, maximum: 14400000 }
        }, ['providerId', 'modelId']), _meta: APP_ONLY, annotations: MUTATING
      },
      {
        name: 'codex_status',
        description: 'Read whether the namespaced Delegation Worker Codex provider is installed.',
        inputSchema: schema(), _meta: APP_ONLY, annotations: READ_ONLY
      },
      {
        name: 'codex_install',
        description: 'Install/update only the namespaced Delegation Worker provider without changing official top-level model/provider selectors.',
        inputSchema: schema(), _meta: APP_ONLY, annotations: MUTATING
      }
    );
  }
  return common;
}

async function call(name, args = {}, context = {}) {
  switch (name) {
    case 'worker_panel': return runtime.status(context);
    case 'delegation_status': return runtime.status(context);
    case 'session_mode_get': return runtime.getMode(context);
    case 'session_mode_set': return runtime.setMode(args, context);
    case 'worker_catalog': return runtime.catalog({ refresh: args.refresh === true }, context);
    case 'worker_profile_get': return runtime.getProfile(context);
    case 'worker_profile_set': return runtime.setProfile(args, context);
    case 'provider_save': return runtime.saveProvider(args);
    case 'provider_delete': return runtime.deleteProvider(args.id);
    case 'provider_refresh': return runtime.refreshProvider(args.id);
    case 'provider_probe': return runtime.probeProvider(args.id, args.modelId);
    case 'provider_model_override': return runtime.setModelOverride(args);
    case 'codex_status': return runtime.codexStatus();
    case 'codex_install': return runtime.codexInstall();
    case 'worker_start':
      if (childMode) throw new Error('nested Delegation Worker spawning is disabled inside Worker Codex threads');
      return runtime.workerStart(args, context);
    case 'worker_status': {
      const value = await runtime.workerStatus(args, context);
      if (!value) throw new Error('worker task not found');
      return value;
    }
    case 'worker_wait': return runtime.workerWait(args, context);
    case 'worker_steer':
      if (childMode) throw new Error('nested Worker steering is disabled');
      return runtime.workerSteer(args, context);
    case 'worker_extend':
      if (childMode) throw new Error('nested Worker renewal is disabled');
      return runtime.workerExtend(args, context);
    case 'worker_respond':
      if (childMode) throw new Error('nested Worker interaction response is disabled');
      return runtime.workerRespond(args, context);
    case 'worker_cancel': return runtime.workerCancel(args, context);
    default: throw Object.assign(new Error(`unknown tool: ${name}`), { code: -32601 });
  }
}

function reply(id, result, error = null) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) })}\n`);
}
function toolResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : { structuredContent: value })
  };
}

async function handle(message) {
  if (message.method === 'initialize') {
    return reply(message.id, {
      protocolVersion: message.params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: 'delegation-worker-mcp', title: 'Delegation Worker MCP', version: '0.2.0' }
    });
  }
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'ping') return reply(message.id, {});
  if (message.method === 'tools/list') return reply(message.id, { tools: tools() });
  if (message.method === 'tools/call') {
    const context = contextFrom(message.params);
    try {
      return reply(message.id, toolResult(await call(message.params?.name, message.params?.arguments || {}, context)));
    } catch (error) {
      return reply(message.id, toolResult({ error: String(error.message || error), code: error.code || 'TOOL_ERROR' }, true));
    }
  }
  if (message.method === 'resources/list') {
    return reply(message.id, {
      resources: [{
        uri: APP_URI, name: 'Worker', title: 'Delegation Worker',
        description: 'Choose Native or Worker mode, provider, model, dynamic reasoning and Worker permissions.',
        mimeType: APP_MIME, _meta: { ui: { title: 'Worker' } }
      }]
    });
  }
  if (message.method === 'resources/templates/list') return reply(message.id, { resourceTemplates: [] });
  if (message.method === 'resources/read') {
    if (message.params?.uri !== APP_URI) return reply(message.id, null, { code: -32002, message: 'resource not found' });
    const html = await fs.readFile(path.join(projectRoot, 'app', 'control.html'), 'utf8');
    return reply(message.id, {
      contents: [{
        uri: APP_URI, mimeType: APP_MIME, text: html,
        _meta: { ui: { title: 'Worker', csp: { connectDomains: [], resourceDomains: [] }, permissions: {} } }
      }]
    });
  }
  if (message.id !== undefined) return reply(message.id, null, { code: -32601, message: 'method not found' });
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  if (Buffer.byteLength(buffer, 'utf8') > MAX_LINE && !buffer.includes('\n')) {
    process.stderr.write('delegation-worker-mcp: MCP input exceeded safe buffer\n');
    process.exit(78);
  }
  while (true) {
    const index = buffer.indexOf('\n');
    if (index < 0) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    handle(message).catch((error) => {
      if (message.id !== undefined) reply(message.id, null, { code: -32603, message: String(error.message || error) });
    });
  }
});

const shutdown = async () => {
  await workers.close().catch(() => {});
  await gateway.close().catch(() => {});
  process.exit(0);
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
