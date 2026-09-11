import crypto from 'node:crypto';
import { CodexAppServerClient } from './app-server.mjs';
import { CODEX_PROVIDER_ID } from './codex-config.mjs';
import { reasoningSelection } from './capabilities.mjs';

const TERMINAL = new Set(['completed', 'failed', 'timed_out', 'cancelled']);
const MAX_EVENTS = 80;

function now() { return new Date().toISOString(); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function summary(message) {
  const method = String(message?.method || 'event'); const p = message?.params || {}; const item = p.item || {};
  if (item.type === 'commandExecution') return { method, type: item.type, text: String(item.command || '').slice(0, 500), status: item.status?.type || item.status || null };
  if (item.type === 'fileChange') return { method, type: item.type, text: `${Array.isArray(item.changes) ? item.changes.length : 0} file changes`, status: item.status?.type || item.status || null };
  if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') return { method, type: item.type, text: `${item.server || item.namespace || ''} ${item.tool || ''}`.trim().slice(0, 500), status: item.status?.type || item.status || null };
  if (method === 'turn/plan/updated') return { method, type: 'plan', text: String(p.explanation || p.plan?.find?.((x) => String(x.status).toLowerCase().includes('progress'))?.step || '').slice(0, 500) };
  return { method, type: item.type || null, text: String(p.message || p.error?.message || '').slice(0, 500) };
}

function phaseFrom(message) {
  const item = message?.params?.item;
  if (item?.type === 'commandExecution') return 'Running command';
  if (item?.type === 'fileChange') return 'Editing files';
  if (item?.type === 'mcpToolCall' || item?.type === 'dynamicToolCall') return 'Using tools';
  if (message?.method === 'turn/plan/updated') return 'Following plan';
  if (message?.method === 'turn/started') return 'Working';
  return null;
}

export class WorkerManager {
  constructor({ store, taskStore, codexConfig, env = process.env, clientFactory = null } = {}) {
    this.store = store; this.taskStore = taskStore; this.codexConfig = codexConfig; this.env = env; this.clientFactory = clientFactory || ((clientEnv) => new CodexAppServerClient({ env: clientEnv })); this.active = new Map(); this.persistChains = new Map();
  }

  async start({ task, cwd = process.cwd(), timeoutMs = 15 * 60 * 1000 } = {}) {
    const prompt = String(task || '').trim(); if (!prompt) throw new Error('task is required');
    if (Buffer.byteLength(prompt, 'utf8') > 512 * 1024) throw new Error('task is too large');
    const profile = await this.store.getProfile();
    if (!profile.enabled) throw new Error('Worker mode is not enabled in the Worker panel');
    const provider = await this.store.provider(profile.providerId); if (!provider) throw new Error('selected provider is unavailable');
    const model = (provider.models || []).find((entry) => entry.id === profile.modelId); if (!model) throw new Error('selected model is unavailable; refresh the provider catalog');
    const reasoning = reasoningSelection(model.reasoning, profile.reasoning);
    const codex = await this.codexConfig.status(); if (!codex.installed) throw new Error('Codex Worker provider is not connected; open the Worker panel and choose Connect Codex');
    const alias = await this.store.createRoute({ providerId: provider.id, modelId: model.id, reasoning, capability: model.reasoning });
    const taskId = `wrk_${crypto.randomBytes(12).toString('base64url')}`;
    const record = {
      taskId, status: 'queued', phase: 'Queued', prompt, cwd: String(cwd || process.cwd()), createdAt: now(), updatedAt: now(), startedAt: null, completedAt: null,
      provider: { id: provider.id, name: provider.name }, model: { id: model.id, name: model.name }, reasoning, access: profile.access, autoVerify: Boolean(profile.autoVerify),
      routeAlias: alias, threadId: null, turnId: null, lastHeartbeatAt: null, lastProgressAt: null, events: [], result: null, verification: null, error: null
    };
    await this.taskStore.write(record);
    const client = this.clientFactory({ ...this.env, DWMCP_WORKER_CHILD: '1' });
    this.active.set(taskId, { client, record, cancelled: false });
    void this.#run(record, client, Math.max(1000, Math.min(60 * 60 * 1000, Number(timeoutMs) || 15 * 60 * 1000)));
    return this.safe(record);
  }

  async #run(record, client, timeoutMs) {
    try {
      record.status = 'running'; record.phase = 'Starting Codex Worker'; record.startedAt = now(); record.updatedAt = now(); await this.#persist(record);
      await client.start();
      const result = await client.runThread({
        model: record.routeAlias, modelProvider: CODEX_PROVIDER_ID, prompt: record.prompt, cwd: record.cwd, sandbox: record.access, timeoutMs,
        developerInstructions: 'You are the implementation Worker. Work directly in the assigned workspace, make the requested changes, run relevant tests, and report concrete results. Do not delegate this task to another Worker.',
        onProgress: (message) => this.#progress(record, message)
      });
      record.threadId = result.threadId || record.threadId; record.turnId = result.turnId || record.turnId;
      if (this.active.get(record.taskId)?.cancelled) { record.status = 'cancelled'; record.phase = 'Cancelled'; }
      else if (String(result.status).toLowerCase().includes('cancel') || String(result.status).toLowerCase().includes('interrupt')) { record.status = 'cancelled'; record.phase = 'Cancelled'; }
      else {
        record.result = { output: result.output, messages: result.messages, status: result.status };
        if (record.autoVerify) {
          record.phase = 'Verifying'; record.updatedAt = now(); await this.#persist(record);
          const verification = await client.runThread({
            model: record.routeAlias, modelProvider: CODEX_PROVIDER_ID, cwd: record.cwd, sandbox: 'read-only', timeoutMs: Math.min(timeoutMs, 10 * 60 * 1000),
            prompt: `Independently verify this completed implementation without modifying files. Inspect the workspace, run safe read-only checks/tests where possible, and report concrete regressions or confirm the result. Original task:\n\n${record.prompt}`,
            developerInstructions: 'You are an independent verifier. Do not modify files. Inspect and test the implementation and report evidence.',
            onProgress: (message) => this.#progress(record, message, 'verification')
          });
          record.verification = { output: verification.output, messages: verification.messages, status: verification.status };
        }
        record.status = 'completed'; record.phase = 'Completed';
      }
    } catch (error) {
      if (this.active.get(record.taskId)?.cancelled) { record.status = 'cancelled'; record.phase = 'Cancelled'; }
      else if (error?.code === 'WORKER_TIMEOUT') { record.status = 'timed_out'; record.phase = 'Timed out'; }
      else { record.status = 'failed'; record.phase = 'Failed'; }
      record.error = { code: String(error?.code || 'WORKER_FAILED'), message: String(error?.message || error).slice(0, 4000) };
    } finally {
      record.completedAt = now(); record.updatedAt = now(); await this.#persist(record); await client.close().catch(() => {}); this.active.delete(record.taskId);
    }
  }

  #progress(record, message, stage = 'worker') {
    const timestamp = now(); const item = summary(message); item.at = timestamp; item.stage = stage;
    record.events.push(item); if (record.events.length > MAX_EVENTS) record.events.splice(0, record.events.length - MAX_EVENTS);
    record.lastHeartbeatAt = timestamp; if (['item/completed', 'turn/plan/updated', 'turn/started'].includes(message?.method)) record.lastProgressAt = timestamp;
    const phase = phaseFrom(message); if (phase) record.phase = stage === 'verification' ? `Verifying · ${phase}` : phase;
    const p = message?.params || {}; const threadId = p.threadId || p.thread?.id; const turnId = p.turnId || p.turn?.id;
    if (threadId) record.threadId = String(threadId); if (turnId) record.turnId = String(turnId); record.updatedAt = timestamp; void this.#persist(record);
  }

  #persist(record) {
    const id = record.taskId; const prior = this.persistChains.get(id) || Promise.resolve(); const snapshot = structuredClone(record);
    const next = prior.catch(() => {}).then(() => this.taskStore.write(snapshot)); this.persistChains.set(id, next);
    return next.finally(() => { if (this.persistChains.get(id) === next) this.persistChains.delete(id); });
  }

  async status(taskId) { const active = this.active.get(taskId)?.record; return this.safe(active || await this.taskStore.read(taskId)); }

  async wait(taskId, waitMs = 170000) {
    const requested = waitMs === undefined ? 170000 : Number(waitMs); const limit = Math.max(0, Math.min(170000, Number.isFinite(requested) ? requested : 170000)); const started = Date.now(); let task = await this.status(taskId); if (!task) throw new Error('worker task not found');
    while (!TERMINAL.has(task.status) && Date.now() - started < limit) { await sleep(Math.min(750, Math.max(1, limit - (Date.now() - started)))); task = await this.status(taskId); }
    return { ...task, waitedMs: Date.now() - started, waitingTimedOut: !TERMINAL.has(task.status) };
  }

  async steer(taskId, text) {
    const active = this.active.get(taskId); if (!active) throw new Error('worker is not active');
    if (!active.record.threadId || !active.record.turnId) throw new Error('worker turn is not ready for steering');
    const direction = String(text || '').trim(); if (!direction) throw new Error('direction is required');
    await active.client.steer(active.record.threadId, active.record.turnId, direction);
    active.record.events.push({ method: 'worker/steer', type: 'steer', text: direction.slice(0, 500), at: now(), stage: 'worker' }); active.record.updatedAt = now(); await this.#persist(active.record);
    return this.safe(active.record);
  }

  async cancel(taskId, reason = 'cancelled by operator') {
    const active = this.active.get(taskId); if (!active) { const stored = await this.taskStore.read(taskId); if (!stored) throw new Error('worker task not found'); return this.safe(stored); }
    active.cancelled = true; active.record.events.push({ method: 'worker/cancel', type: 'cancel', text: String(reason).slice(0, 500), at: now(), stage: 'worker' });
    if (active.record.threadId && active.record.turnId) await active.client.interrupt(active.record.threadId, active.record.turnId).catch(() => {});
    active.record.status = 'cancelled'; active.record.phase = 'Cancelling'; active.record.updatedAt = now(); await this.#persist(active.record); return this.safe(active.record);
  }

  safe(record) {
    if (!record) return null;
    const { routeAlias, ...safe } = structuredClone(record);
    safe.prompt = safe.prompt?.slice(0, 16000) || '';
    return safe;
  }
}
