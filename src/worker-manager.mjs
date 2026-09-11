import crypto from 'node:crypto';
import { CodexAppServerClient } from './app-server.mjs';
import { CODEX_PROVIDER_ID } from './codex-config.mjs';
import { reasoningSelection } from './capabilities.mjs';
import { DEFAULT_LEASE_MS, DEFAULT_MAX_TOTAL_MS } from './store.mjs';

const TERMINAL = new Set(['completed', 'failed', 'timed_out', 'cancelled']);
const MAX_EVENTS = 100;
const HEARTBEAT_MS = 5000;
const REVIEW_LEAD_MS = 90_000;
const STALE_PROGRESS_MS = 5 * 60 * 1000;
const HEARTBEAT_GRACE_MS = 2 * 60 * 1000;

function nowMs() { return Date.now(); }
function iso(value = Date.now()) { return new Date(value).toISOString(); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function terminal(task) { return TERMINAL.has(task?.status); }
function boundedText(value, max = 500) { return String(value ?? '').replace(/[\0]/g, '').slice(0, max); }

function safeObject(value, depth = 0) {
  if (depth > 5) return '[depth-limited]';
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return boundedText(value, 4000);
  if (Array.isArray(value)) return value.slice(0, 64).map((item) => safeObject(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 80)) out[boundedText(key, 128)] = safeObject(item, depth + 1);
    return out;
  }
  return boundedText(value, 1000);
}

function summary(message) {
  const method = String(message?.method || 'event');
  const p = message?.params || {};
  const item = p.item || {};
  if (item.type === 'commandExecution') {
    return { method, type: item.type, text: boundedText(item.command || item.commandLine || 'command', 700), status: item.status?.type || item.status || null };
  }
  if (item.type === 'fileChange') {
    return { method, type: item.type, text: `${Array.isArray(item.changes) ? item.changes.length : 0} file changes`, status: item.status?.type || item.status || null };
  }
  if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
    return { method, type: item.type, text: boundedText(`${item.server || item.namespace || ''} ${item.tool || ''}`.trim(), 700), status: item.status?.type || item.status || null };
  }
  if (method === 'turn/plan/updated') {
    const active = Array.isArray(p.plan) ? p.plan.find((x) => /progress|active/i.test(String(x.status || ''))) : null;
    return { method, type: 'plan', text: boundedText(p.explanation || active?.step || 'plan updated', 700), status: active?.status || null };
  }
  if (method === 'delegation/serverRequest') {
    return { method, type: 'interaction', text: boundedText(p.method || 'Codex interaction required', 700), status: 'pending' };
  }
  return { method, type: item.type || null, text: boundedText(p.message || p.error?.message || '', 700), status: item.status?.type || item.status || null };
}

function phaseFrom(message) {
  const item = message?.params?.item;
  if (item?.type === 'commandExecution') return 'Running command';
  if (item?.type === 'fileChange') return 'Editing files';
  if (item?.type === 'mcpToolCall' || item?.type === 'dynamicToolCall') return 'Using tools';
  if (message?.method === 'turn/plan/updated') return 'Following plan';
  if (message?.method === 'turn/started') return 'Working';
  if (message?.method === 'delegation/serverRequest') return 'Waiting for supervisor';
  return null;
}

function meaningful(message) {
  const method = String(message?.method || '');
  if (['turn/started', 'turn/plan/updated', 'item/started', 'item/completed', 'delegation/serverRequest'].includes(method)) return true;
  return method.startsWith('item/') && !method.includes('/delta');
}

function progressEvidence(record) {
  const now = nowMs();
  const heartbeat = Date.parse(record.lastHeartbeatAt || '') || 0;
  const progress = Date.parse(record.lastMeaningfulProgressAt || record.startedAt || '') || 0;
  const heartbeatAgeMs = heartbeat ? Math.max(0, now - heartbeat) : null;
  const meaningfulProgressAgeMs = progress ? Math.max(0, now - progress) : null;
  const heartbeatHealthy = heartbeatAgeMs !== null && heartbeatAgeMs <= HEARTBEAT_MS * 4;
  const progressHealthy = meaningfulProgressAgeMs !== null && meaningfulProgressAgeMs <= STALE_PROGRESS_MS;
  return {
    state: !heartbeatHealthy ? 'stalled' : (progressHealthy ? 'progressing' : 'heartbeat_only'),
    heartbeatAgeMs,
    meaningfulProgressAgeMs
  };
}

export class WorkerManager {
  constructor({ store, taskStore, codexConfig, env = process.env, clientFactory = null } = {}) {
    this.store = store;
    this.taskStore = taskStore;
    this.codexConfig = codexConfig;
    this.env = env;
    this.clientFactory = clientFactory || ((clientEnv) => new CodexAppServerClient({ env: clientEnv }));
    this.active = new Map();
    this.persistChains = new Map();
  }

  async initialize() {
    for (const task of await this.taskStore.list(100)) {
      if (!task || terminal(task)) continue;
      task.status = 'failed';
      task.phase = 'Stopped after control-plane restart';
      task.completedAt = iso();
      task.updatedAt = task.completedAt;
      task.error = { code: 'WORKER_CONTROL_PLANE_RESTARTED', message: 'Worker process ownership was lost when Delegation Worker MCP restarted.' };
      task.events ||= [];
      task.events.push({ at: task.completedAt, method: 'worker/recovered', type: 'recovery', text: task.error.message, stage: 'worker' });
      await this.taskStore.write(task);
    }
  }

  async start({ task, cwd = process.cwd(), supervisorThreadId = '' } = {}) {
    const prompt = String(task || '').trim();
    if (!prompt) throw new Error('task is required');
    if (Buffer.byteLength(prompt, 'utf8') > 512 * 1024) throw new Error('task is too large');

    const session = await this.store.getSession(supervisorThreadId);
    if (session.mode !== 'WORKER') throw new Error('current session is in NATIVE mode; enable Worker mode in the Worker panel first');
    const profile = session.profile;
    const provider = await this.store.provider(profile.providerId);
    if (!provider) throw new Error('selected provider is unavailable');
    const model = (provider.models || []).find((entry) => entry.id === profile.modelId);
    if (!model) throw new Error('selected model is unavailable; refresh the provider catalog');
    const reasoning = reasoningSelection(model.reasoning, profile.reasoning);
    const codex = await this.codexConfig.status();
    if (!codex.installed) throw new Error('Codex Worker provider is not connected; open the Worker panel and choose Connect Codex');

    const alias = await this.store.createRoute({ providerId: provider.id, modelId: model.id, reasoning, capability: model.reasoning });
    const taskId = `wrk_${crypto.randomBytes(12).toString('base64url')}`;
    const leaseMs = Math.max(60_000, Math.min(Number(profile.leaseMs) || DEFAULT_LEASE_MS, Number(profile.maxTotalMs) || DEFAULT_MAX_TOTAL_MS));
    const maxTotalMs = Math.max(leaseMs, Number(profile.maxTotalMs) || DEFAULT_MAX_TOTAL_MS);
    const record = {
      taskId,
      supervisorThreadId: String(supervisorThreadId || '') || null,
      status: 'queued',
      phase: 'Queued',
      prompt,
      cwd: String(cwd || process.cwd()),
      createdAt: iso(),
      updatedAt: iso(),
      startedAt: null,
      completedAt: null,
      provider: { id: provider.id, name: provider.name },
      model: { id: model.id, name: model.name },
      reasoning,
      access: profile.access,
      autoVerify: Boolean(profile.autoVerify),
      supervision: {
        autoExtend: profile.autoExtend !== false,
        leaseMs,
        maxTotalMs,
        leaseDeadlineAt: null,
        hardDeadlineAt: null,
        reviewAt: null,
        reviewDue: false,
        extensionCount: 0,
        autoExtensionCount: 0,
        graceUsed: false,
        lastDecision: null,
        lastReason: null
      },
      routeAlias: alias,
      threadId: null,
      turnId: null,
      lastHeartbeatAt: null,
      lastProgressAt: null,
      lastMeaningfulProgressAt: null,
      latestAction: null,
      plan: null,
      pendingInteraction: null,
      events: [],
      result: null,
      verification: null,
      error: null
    };
    await this.taskStore.write(record);
    const client = this.clientFactory({ ...this.env, DWMCP_WORKER_CHILD: '1' });
    const active = { client, record, cancelled: false, reviewTimer: null, deadlineTimer: null, heartbeatTimer: null, heartbeatCount: 0 };
    this.active.set(taskId, active);
    client.setServerRequestHandler?.((request) => this.#serverRequest(record, request));
    void this.#run(record, client);
    return this.safe(record);
  }

  async #run(record, client) {
    const active = this.active.get(record.taskId);
    try {
      const started = nowMs();
      record.status = 'running';
      record.phase = 'Starting Codex Worker';
      record.startedAt = iso(started);
      record.lastHeartbeatAt = record.startedAt;
      record.lastMeaningfulProgressAt = record.startedAt;
      record.supervision.hardDeadlineAt = iso(started + record.supervision.maxTotalMs);
      record.supervision.leaseDeadlineAt = iso(started + record.supervision.leaseMs);
      record.supervision.reviewAt = iso(Math.max(started, started + record.supervision.leaseMs - Math.min(REVIEW_LEAD_MS, Math.floor(record.supervision.leaseMs / 2))));
      record.updatedAt = iso();
      await this.#persist(record);
      this.#startHeartbeat(active);
      this.#scheduleSupervision(active);
      await client.start();

      const result = await client.runThread({
        model: record.routeAlias,
        modelProvider: CODEX_PROVIDER_ID,
        prompt: record.prompt,
        cwd: record.cwd,
        sandbox: record.access,
        timeoutMs: record.supervision.maxTotalMs,
        developerInstructions: [
          'You are the implementation Worker inside the official Codex runtime.',
          'Own the assigned implementation task in the current workspace.',
          'Use the Codex tools available to you directly: inspect files, edit, run commands/tests, and use configured MCP tools when useful.',
          'Keep a concrete execution plan when the task is non-trivial, make measurable progress, and report evidence.',
          'Do not spawn another Delegation Worker and do not change the supervisor session policy.'
        ].join(' '),
        onProgress: (message) => this.#progress(record, message)
      });

      record.threadId = result.threadId || record.threadId;
      record.turnId = result.turnId || record.turnId;
      if (active?.cancelled) {
        record.status = 'cancelled';
        record.phase = 'Cancelled';
      } else if (/cancel|interrupt/i.test(String(result.status))) {
        record.status = 'cancelled';
        record.phase = 'Cancelled';
      } else {
        record.result = { output: result.output, messages: result.messages, status: result.status };
        if (record.autoVerify) {
          this.#clearSupervision(active);
          record.phase = 'Verifying';
          record.updatedAt = iso();
          await this.#persist(record);
          const verification = await client.runThread({
            model: record.routeAlias,
            modelProvider: CODEX_PROVIDER_ID,
            cwd: record.cwd,
            sandbox: 'read-only',
            timeoutMs: Math.min(10 * 60 * 1000, Math.max(60_000, record.supervision.maxTotalMs)),
            prompt: `Independently verify this completed implementation without modifying files. Inspect the workspace and run checks that are compatible with a read-only sandbox. Identify concrete regressions or confirm the result with evidence. Original task:\n\n${record.prompt}`,
            developerInstructions: 'You are an independent verifier. The sandbox is read-only. Inspect and validate; never modify project files.',
            onProgress: (message) => this.#progress(record, message, 'verification')
          });
          record.verification = { output: verification.output, messages: verification.messages, status: verification.status };
        }
        record.status = 'completed';
        record.phase = 'Completed';
      }
    } catch (error) {
      if (active?.cancelled) {
        record.status = 'cancelled';
        record.phase = 'Cancelled';
      } else if (/TIMEOUT/.test(String(error?.code || ''))) {
        record.status = 'timed_out';
        record.phase = 'Timed out';
      } else {
        record.status = 'failed';
        record.phase = 'Failed';
      }
      record.error = { code: String(error?.code || 'WORKER_FAILED'), message: boundedText(error?.message || error, 4000) };
    } finally {
      this.#clearSupervision(active);
      client.rejectAllServerRequests?.('worker task ended');
      record.pendingInteraction = null;
      record.completedAt = record.completedAt || iso();
      record.updatedAt = iso();
      await this.#persist(record);
      await client.close().catch(() => {});
      this.active.delete(record.taskId);
    }
  }

  #startHeartbeat(active) {
    if (!active) return;
    active.heartbeatTimer = setInterval(() => {
      if (terminal(active.record)) return;
      active.record.lastHeartbeatAt = iso();
      active.record.updatedAt = active.record.lastHeartbeatAt;
      active.heartbeatCount += 1;
      if (active.heartbeatCount % 6 === 0) void this.#persist(active.record);
    }, HEARTBEAT_MS);
    active.heartbeatTimer.unref?.();
  }

  #clearSupervision(active) {
    if (!active) return;
    if (active.reviewTimer) clearTimeout(active.reviewTimer);
    if (active.deadlineTimer) clearTimeout(active.deadlineTimer);
    if (active.heartbeatTimer) clearInterval(active.heartbeatTimer);
    active.reviewTimer = active.deadlineTimer = active.heartbeatTimer = null;
  }

  #scheduleSupervision(active) {
    if (!active || terminal(active.record)) return;
    if (active.reviewTimer) clearTimeout(active.reviewTimer);
    if (active.deadlineTimer) clearTimeout(active.deadlineTimer);
    const reviewAt = Date.parse(active.record.supervision.reviewAt || '') || nowMs();
    const deadlineAt = Date.parse(active.record.supervision.leaseDeadlineAt || '') || nowMs();
    active.reviewTimer = setTimeout(() => void this.#review(active.record.taskId).catch(() => {}), Math.max(0, reviewAt - nowMs()));
    active.deadlineTimer = setTimeout(() => void this.#leaseExpired(active.record.taskId).catch(() => {}), Math.max(1, deadlineAt - nowMs()));
    active.reviewTimer.unref?.();
    active.deadlineTimer.unref?.();
  }

  async #review(taskId) {
    const active = this.active.get(taskId);
    if (!active || terminal(active.record)) return;
    const record = active.record;
    record.supervision.reviewDue = true;
    const evidence = progressEvidence(record);
    record.events.push({
      at: iso(), method: 'worker/review', type: 'review',
      text: `supervision review: ${evidence.state}`, stage: 'worker'
    });
    this.#trimEvents(record);

    if (!record.supervision.autoExtend) {
      record.phase = 'Awaiting supervisor renewal';
      record.supervision.lastDecision = 'review_due';
      record.supervision.lastReason = 'automatic renewal is disabled';
      await this.#persist(record);
      return;
    }

    if (evidence.state === 'progressing') {
      await this.extend(taskId, {
        extraMs: record.supervision.leaseMs,
        reason: 'automatic renewal: Worker has recent meaningful progress and a healthy heartbeat',
        automatic: true
      }, record.supervisorThreadId || '');
      return;
    }

    if (evidence.state === 'heartbeat_only' && !record.supervision.graceUsed) {
      record.supervision.graceUsed = true;
      await this.extend(taskId, {
        extraMs: Math.min(HEARTBEAT_GRACE_MS, record.supervision.leaseMs),
        reason: 'automatic bounded grace: Worker heartbeat is healthy but no recent progress event was observed',
        automatic: true
      }, record.supervisorThreadId || '');
      return;
    }

    const reason = evidence.state === 'stalled'
      ? 'supervision stopped Worker because the control heartbeat is stale'
      : 'supervision stopped Worker because the grace period ended without meaningful progress';
    record.supervision.lastDecision = 'cancelled';
    record.supervision.lastReason = reason;
    await this.#persist(record);
    await this.cancel(taskId, reason, record.supervisorThreadId || '');
  }

  async #leaseExpired(taskId) {
    const active = this.active.get(taskId);
    if (!active || terminal(active.record)) return;
    const deadline = Date.parse(active.record.supervision.leaseDeadlineAt || '') || 0;
    if (deadline > nowMs() + 50) {
      this.#scheduleSupervision(active);
      return;
    }
    await this.cancel(taskId, 'Worker lease expired before a bounded renewal was accepted', active.record.supervisorThreadId || '');
  }

  async extend(taskId, { extraMs, reason = 'extended by supervisor', automatic = false } = {}, supervisorThreadId = '') {
    const active = this.active.get(taskId);
    if (!active) throw new Error('worker is not active');
    this.#authorize(active.record, supervisorThreadId);
    const record = active.record;
    const current = Date.parse(record.supervision.leaseDeadlineAt || '') || nowMs();
    const hard = Date.parse(record.supervision.hardDeadlineAt || '') || current;
    const requested = Math.max(1000, Math.min(Number(extraMs) || record.supervision.leaseMs, record.supervision.leaseMs));
    const next = Math.min(hard, Math.max(current, nowMs()) + requested);
    if (next <= current) throw Object.assign(new Error('Worker reached its hard maximum runtime'), { code: 'WORKER_MAX_TOTAL_REACHED' });

    record.supervision.leaseDeadlineAt = iso(next);
    const lead = Math.min(REVIEW_LEAD_MS, Math.max(1000, Math.floor((next - nowMs()) / 2)));
    record.supervision.reviewAt = iso(Math.max(nowMs(), next - lead));
    record.supervision.reviewDue = false;
    record.supervision.extensionCount += 1;
    if (automatic) record.supervision.autoExtensionCount += 1;
    record.supervision.lastDecision = automatic ? 'auto_extended' : 'extended';
    record.supervision.lastReason = boundedText(reason, 1000);
    record.phase = record.pendingInteraction ? 'Waiting for supervisor' : 'Working';
    record.events.push({
      at: iso(), method: 'worker/extended', type: 'lease',
      text: `${automatic ? 'automatic' : 'manual'} renewal until ${record.supervision.leaseDeadlineAt}: ${boundedText(reason, 500)}`,
      stage: 'worker'
    });
    this.#trimEvents(record);
    record.updatedAt = iso();
    await this.#persist(record);
    this.#scheduleSupervision(active);
    return this.safe(record);
  }

  #serverRequest(record, request) {
    if (!record || terminal(record)) return;
    record.pendingInteraction = {
      requestId: String(request.id),
      method: boundedText(request.method, 256),
      params: safeObject(request.params),
      receivedAt: request.receivedAt || iso()
    };
    record.phase = 'Waiting for supervisor';
    record.lastMeaningfulProgressAt = iso();
    record.events.push({
      at: iso(), method: 'worker/interaction', type: 'interaction',
      text: boundedText(`Codex requested supervisor input: ${request.method}`, 700),
      stage: 'worker'
    });
    this.#trimEvents(record);
    record.updatedAt = iso();
    void this.#persist(record);
  }

  async respond(taskId, { requestId, response = {}, reject = false, reason = 'rejected by supervisor' } = {}, supervisorThreadId = '') {
    const active = this.active.get(taskId);
    if (!active) throw new Error('worker is not active');
    this.#authorize(active.record, supervisorThreadId);
    const expected = active.record.pendingInteraction?.requestId;
    const id = String(requestId || expected || '');
    if (!id || !expected || id !== expected) throw new Error('requestId does not match the current pending interaction');
    const outcome = reject
      ? active.client.rejectServerRequest(id, reason)
      : active.client.respondServerRequest(id, response && typeof response === 'object' ? response : {});
    active.record.pendingInteraction = null;
    active.record.phase = 'Working';
    active.record.lastMeaningfulProgressAt = iso();
    active.record.events.push({
      at: iso(), method: 'worker/interactionResolved', type: 'interaction',
      text: reject ? `supervisor rejected ${id}` : `supervisor answered ${id}`, stage: 'worker'
    });
    this.#trimEvents(active.record);
    await this.#persist(active.record);
    return { outcome, task: this.safe(active.record) };
  }

  #progress(record, message, stage = 'worker') {
    if (!record || terminal(record)) return;
    const timestamp = iso();
    const item = summary(message);
    item.at = timestamp;
    item.stage = stage;
    record.events.push(item);
    this.#trimEvents(record);
    record.lastHeartbeatAt = timestamp;
    record.lastProgressAt = timestamp;
    if (meaningful(message)) record.lastMeaningfulProgressAt = timestamp;
    const phase = phaseFrom(message);
    if (phase && !record.pendingInteraction) record.phase = stage === 'verification' ? `Verifying · ${phase}` : phase;
    const p = message?.params || {};
    const threadId = p.threadId || p.thread?.id;
    const turnId = p.turnId || p.turn?.id;
    if (threadId) record.threadId = String(threadId);
    if (turnId) record.turnId = String(turnId);
    if (message?.method === 'turn/plan/updated') {
      record.plan = {
        explanation: boundedText(p.explanation || '', 4000),
        steps: Array.isArray(p.plan) ? p.plan.slice(0, 100).map((step) => safeObject(step)) : []
      };
    }
    if (item.text) record.latestAction = { type: item.type, text: item.text, status: item.status, at: timestamp, stage };
    record.updatedAt = timestamp;
    void this.#persist(record);
  }

  #trimEvents(record) {
    if (record.events.length > MAX_EVENTS) record.events.splice(0, record.events.length - MAX_EVENTS);
  }

  #persist(record) {
    const id = record.taskId;
    const prior = this.persistChains.get(id) || Promise.resolve();
    const snapshot = structuredClone(record);
    const next = prior.catch(() => {}).then(() => this.taskStore.write(snapshot));
    this.persistChains.set(id, next);
    return next.finally(() => { if (this.persistChains.get(id) === next) this.persistChains.delete(id); });
  }

  #authorize(record, supervisorThreadId) {
    const expected = String(record?.supervisorThreadId || '');
    const actual = String(supervisorThreadId || '');
    if (expected && expected !== actual) throw Object.assign(new Error('Worker task belongs to a different supervisor session'), { code: 'WORKER_SESSION_MISMATCH' });
  }

  async status(taskId, supervisorThreadId = '') {
    const active = this.active.get(taskId)?.record;
    const task = active || await this.taskStore.read(taskId);
    if (!task) return null;
    this.#authorize(task, supervisorThreadId);
    return this.safe(task);
  }

  async currentForSupervisor(supervisorThreadId = '') {
    const id = String(supervisorThreadId || '');
    const active = [...this.active.values()].map((entry) => entry.record)
      .filter((task) => String(task.supervisorThreadId || '') === id && !terminal(task))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    return active ? this.safe(active) : null;
  }

  async wait(taskId, waitMs = 170000, supervisorThreadId = '') {
    const requested = waitMs === undefined ? 170000 : Number(waitMs);
    const limit = Math.max(0, Math.min(170000, Number.isFinite(requested) ? requested : 170000));
    const started = nowMs();
    let task = await this.status(taskId, supervisorThreadId);
    if (!task) throw new Error('worker task not found');
    while (!terminal(task) && nowMs() - started < limit) {
      await sleep(Math.min(750, Math.max(1, limit - (nowMs() - started))));
      task = await this.status(taskId, supervisorThreadId);
    }
    return { ...task, waitedMs: nowMs() - started, waitingTimedOut: !terminal(task) };
  }

  async steer(taskId, text, supervisorThreadId = '') {
    const active = this.active.get(taskId);
    if (!active) throw new Error('worker is not active');
    this.#authorize(active.record, supervisorThreadId);
    if (!active.record.threadId || !active.record.turnId) throw new Error('worker turn is not ready for steering');
    const direction = String(text || '').trim();
    if (!direction) throw new Error('direction is required');
    await active.client.steer(active.record.threadId, active.record.turnId, direction);
    active.record.events.push({ at: iso(), method: 'worker/steer', type: 'steer', text: boundedText(direction, 700), stage: 'worker' });
    active.record.lastMeaningfulProgressAt = iso();
    active.record.updatedAt = iso();
    this.#trimEvents(active.record);
    await this.#persist(active.record);
    return this.safe(active.record);
  }

  async cancel(taskId, reason = 'cancelled by operator', supervisorThreadId = '') {
    const active = this.active.get(taskId);
    if (!active) {
      const stored = await this.taskStore.read(taskId);
      if (!stored) throw new Error('worker task not found');
      this.#authorize(stored, supervisorThreadId);
      return this.safe(stored);
    }
    this.#authorize(active.record, supervisorThreadId);
    active.cancelled = true;
    active.record.events.push({ at: iso(), method: 'worker/cancel', type: 'cancel', text: boundedText(reason, 700), stage: 'worker' });
    this.#trimEvents(active.record);
    if (active.record.threadId && active.record.turnId) await active.client.interrupt(active.record.threadId, active.record.turnId).catch(() => {});
    active.client.rejectAllServerRequests?.('Worker cancelled by supervisor');
    active.record.pendingInteraction = null;
    active.record.status = 'cancelled';
    active.record.phase = 'Cancelling';
    active.record.updatedAt = iso();
    await this.#persist(active.record);
    return this.safe(active.record);
  }

  async cancelForSupervisor(supervisorThreadId, reason = 'cancelled by supervisor mode change') {
    const id = String(supervisorThreadId || '');
    const matches = [...this.active.values()].filter((entry) => String(entry.record.supervisorThreadId || '') === id);
    const results = [];
    for (const entry of matches) results.push(await this.cancel(entry.record.taskId, reason, id).catch((error) => ({ error: error.message })));
    return results;
  }

  async close() {
    const entries = [...this.active.values()];
    for (const entry of entries) {
      const supervisor = String(entry.record.supervisorThreadId || '');
      await this.cancel(entry.record.taskId, 'Delegation Worker MCP is shutting down', supervisor).catch(() => {});
    }
    await Promise.allSettled(entries.map((entry) => entry.client.close?.()));
  }

  safe(record) {
    if (!record) return null;
    const { routeAlias, ...safe } = structuredClone(record);
    safe.prompt = safe.prompt?.slice(0, 16000) || '';
    safe.progressEvidence = terminal(safe) ? { state: 'terminal', heartbeatAgeMs: null, meaningfulProgressAgeMs: null } : progressEvidence(safe);
    return safe;
  }
}
