import crypto from 'node:crypto';
import { CodexAppServerClient } from './app-server.mjs';
import { CODEX_PROVIDER_ID } from './codex-config.mjs';
import { reasoningSelection } from './capabilities.mjs';
import { DEFAULT_LEASE_MS, DEFAULT_MAX_TOTAL_MS } from './store.mjs';
import { codexParity } from './codex-model-info.mjs';

const TERMINAL = new Set(['completed', 'failed', 'timed_out', 'cancelled', 'verification_failed', 'needs_followup']);
const MAX_EVENTS = 100;
const MAX_PENDING_INTERACTIONS = 16;
const VERIFIER_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail', 'inconclusive'] },
    summary: { type: 'string' },
    checks: { type: 'array', items: { type: 'string' } },
    findings: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'array', items: { type: 'string' } }
  },
  required: ['verdict', 'summary', 'checks', 'findings', 'evidence'],
  additionalProperties: false
};
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
  const controller = Date.parse(record.controllerLivenessAt || record.startedAt || '') || 0;
  const runtime = Date.parse(record.lastRuntimeEventAt || record.startedAt || '') || 0;
  const progress = Date.parse(record.lastMeaningfulProgressAt || record.startedAt || '') || 0;
  const controllerLivenessAgeMs = controller ? Math.max(0, now - controller) : null;
  const runtimeEventAgeMs = runtime ? Math.max(0, now - runtime) : null;
  const meaningfulProgressAgeMs = progress ? Math.max(0, now - progress) : null;
  const controllerHealthy = controllerLivenessAgeMs !== null && controllerLivenessAgeMs <= HEARTBEAT_MS * 4;
  const progressHealthy = meaningfulProgressAgeMs !== null && meaningfulProgressAgeMs <= STALE_PROGRESS_MS;
  return {
    state: !controllerHealthy ? 'control_plane_stalled' : (progressHealthy ? 'progressing' : 'runtime_quiet'),
    controllerLivenessAgeMs,
    runtimeEventAgeMs,
    meaningfulProgressAgeMs
  };
}

function verificationResult(result) {
  const base = {
    status: result?.status || null,
    output: result?.output || '',
    messages: Array.isArray(result?.messages) ? result.messages : [],
    verdict: 'inconclusive',
    summary: '',
    checks: [],
    findings: [],
    evidence: []
  };
  try {
    const parsed = JSON.parse(String(result?.output || '').trim());
    if (!['pass', 'fail', 'inconclusive'].includes(parsed?.verdict)) throw new Error('invalid verifier verdict');
    return {
      ...base,
      verdict: parsed.verdict,
      summary: boundedText(parsed.summary, 4000),
      checks: Array.isArray(parsed.checks) ? parsed.checks.slice(0, 100).map((value) => boundedText(value, 1000)) : [],
      findings: Array.isArray(parsed.findings) ? parsed.findings.slice(0, 100).map((value) => boundedText(value, 2000)) : [],
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence.slice(0, 100).map((value) => boundedText(value, 2000)) : []
    };
  } catch (error) {
    return {
      ...base,
      summary: 'Verifier output could not be parsed as the required structured verdict.',
      findings: [boundedText(error?.message || error, 1000)]
    };
  }
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
    for (const task of await this.taskStore.list(1000)) {
      if (!task || terminal(task)) continue;
      const previousStatus = task.status;
      task.status = 'failed';
      task.phase = 'Control plane restarted';
      task.completedAt = iso();
      task.updatedAt = task.completedAt;
      task.recovery = {
        strategy: 'fail_closed_no_reattach',
        previousStatus,
        recoveredAt: task.completedAt,
        officialInterruptConfirmed: false
      };
      task.error = {
        code: 'WORKER_CONTROL_PLANE_RESTARTED',
        message: 'Delegation Worker MCP restarted and no live Codex process ownership or authoritative interrupt proof is available. The persisted task is failed closed rather than reported as cancelled or completed.'
      };
      task.events ||= [];
      task.events.push({
        at: task.completedAt,
        method: 'worker/recovered',
        type: 'recovery',
        text: task.error.message,
        stage: 'worker'
      });
      await this.taskStore.write(task);
    }
    await this.taskStore.prune().catch(() => {});
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
      compatibility: codexParity(model),
      backend: 'official-thread-start',
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