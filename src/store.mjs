import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { atomicWrite, readJsonFile, withFileLock } from './atomic.mjs';
import { gatewayTokenPath, statePath } from './paths.mjs';

export const SESSION_MODES = Object.freeze(['NATIVE', 'WORKER']);
export const DEFAULT_LEASE_MS = 15 * 60 * 1000;
export const DEFAULT_MAX_TOTAL_MS = 60 * 60 * 1000;

const DEFAULT_PROFILE = Object.freeze({
  providerId: '',
  modelId: '',
  reasoning: 'auto',
  access: 'danger-full-access',
  autoVerify: true,
  autoExtend: true,
  leaseMs: DEFAULT_LEASE_MS,
  maxTotalMs: DEFAULT_MAX_TOTAL_MS
});

const EMPTY = Object.freeze({
  schemaVersion: 2,
  defaultMode: 'NATIVE',
  defaultProfile: DEFAULT_PROFILE,
  sessions: {},
  providers: {},
  routes: {},
  overrides: {},
  protocolCache: {},
  updatedAt: null
});

function clampDuration(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function normalizeProfile(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const leaseMs = clampDuration(source.leaseMs, DEFAULT_LEASE_MS, 60_000, DEFAULT_MAX_TOTAL_MS);
  const maxTotalMs = clampDuration(source.maxTotalMs, DEFAULT_MAX_TOTAL_MS, leaseMs, 4 * 60 * 60 * 1000);
  return {
    providerId: String(source.providerId || '').slice(0, 80),
    modelId: String(source.modelId || '').slice(0, 512),
    reasoning: String(source.reasoning || 'auto').slice(0, 128),
    access: ['danger-full-access', 'workspace-write', 'read-only'].includes(source.access) ? source.access : 'danger-full-access',
    autoVerify: source.autoVerify !== false,
    autoExtend: source.autoExtend !== false,
    leaseMs,
    maxTotalMs
  };
}

function normalizeMode(value) {
  const mode = String(value || '').toUpperCase();
  return SESSION_MODES.includes(mode) ? mode : 'NATIVE';
}

function normalizeSession(value, fallbackProfile) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    mode: normalizeMode(source.mode),
    profile: normalizeProfile({ ...fallbackProfile, ...(source.profile || {}) }),
    updatedAt: source.updatedAt || null
  };
}

function cleanState(value) {
  const state = value && typeof value === 'object' ? value : {};
  // v0.1 stored one global "profile". Treat it as the v0.2 default profile so
  // upgrades are lossless while Codex calls immediately move to per-thread state.
  const legacyProfile = state.profile && typeof state.profile === 'object' ? state.profile : {};
  const defaultProfile = normalizeProfile({ ...legacyProfile, ...(state.defaultProfile || {}) });
  const sessions = {};
  for (const [id, session] of Object.entries(state.sessions && typeof state.sessions === 'object' ? state.sessions : {})) {
    if (validSessionId(id)) sessions[id] = normalizeSession(session, defaultProfile);
  }
  return {
    schemaVersion: 2,
    defaultMode: normalizeMode(state.defaultMode),
    defaultProfile,
    sessions,
    providers: state.providers && typeof state.providers === 'object' ? state.providers : {},
    routes: state.routes && typeof state.routes === 'object' ? state.routes : {},
    overrides: state.overrides && typeof state.overrides === 'object' ? state.overrides : {},
    protocolCache: state.protocolCache && typeof state.protocolCache === 'object' ? state.protocolCache : {},
    updatedAt: state.updatedAt || null
  };
}

function validSessionId(value) {
  const id = String(value || '');
  return id.length >= 1 && id.length <= 256 && !/[\0\r\n]/.test(id);
}

function publicProvider(provider) {
  if (!provider) return null;
  const { apiKeyCipher, ...safe } = provider;
  return { ...safe, apiKeyConfigured: Boolean(apiKeyCipher) };
}

export class StateStore {
  constructor({ env = process.env } = {}) {
    this.env = env;
    this.file = statePath(env);
    this.tokenFile = gatewayTokenPath(env);
  }

  async read() { return cleanState(await readJsonFile(this.file, EMPTY)); }

  async update(mutator) {
    return withFileLock(this.file, async () => {
      const state = await this.read();
      const next = cleanState(await mutator(state) || state);
      next.updatedAt = new Date().toISOString();
      await atomicWrite(this.file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      return next;
    });
  }

  async gatewayToken() {
    try {
      const token = (await fs.readFile(this.tokenFile, 'utf8')).trim();
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('gateway token is malformed');
      return token;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const token = crypto.randomBytes(32).toString('base64url');
      await atomicWrite(this.tokenFile, `${token}\n`, { mode: 0o600 });
      return token;
    }
  }

  async listProviders() {
    const state = await this.read();
    return Object.values(state.providers).map(publicProvider).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  async provider(id) { return (await this.read()).providers[id] || null; }

  async saveProvider(input) {
    let id = String(input.id || '').trim();
    if (id && !/^[A-Za-z0-9_-]{3,80}$/.test(id)) throw new Error('invalid provider id');
    if (!id) id = `p_${crypto.randomBytes(7).toString('base64url')}`;
    const now = new Date().toISOString();
    await this.update((state) => {
      const previous = state.providers[id] || {};
      state.providers[id] = {
        id,
        name: String(input.name || previous.name || 'Provider').trim().slice(0, 120),
        adapter: String(input.adapter || previous.adapter || 'openai-compatible'),
        baseUrl: String(input.baseUrl || previous.baseUrl || '').trim(),
        authType: String(input.authType || previous.authType || 'bearer'),
        headerName: input.headerName ? String(input.headerName).slice(0, 64) : (previous.headerName || null),
        headers: input.headers && typeof input.headers === 'object' ? input.headers : (previous.headers || {}),
        apiKeyCipher: input.apiKeyCipher !== undefined ? input.apiKeyCipher : (previous.apiKeyCipher || ''),
        models: Array.isArray(previous.models) ? previous.models : [],
        refreshedAt: previous.refreshedAt || null,
        createdAt: previous.createdAt || now,
        updatedAt: now
      };
      return state;
    });
    return publicProvider(await this.provider(id));
  }

  async deleteProvider(id) {
    await this.update((state) => {
      delete state.providers[id];
      delete state.overrides[id];
      for (const key of Object.keys(state.protocolCache)) if (key.startsWith(`${id}:`)) delete state.protocolCache[key];
      for (const [alias, route] of Object.entries(state.routes)) if (route.providerId === id) delete state.routes[alias];
      if (state.defaultProfile.providerId === id) state.defaultProfile = normalizeProfile();
      for (const session of Object.values(state.sessions)) if (session.profile?.providerId === id) {
        session.profile = normalizeProfile(state.defaultProfile);
        session.mode = 'NATIVE';
        session.updatedAt = new Date().toISOString();
      }
      return state;
    });
    return { removed: true, id };
  }

  async setProviderModels(id, models) {
    const refreshedAt = new Date().toISOString();
    await this.update((state) => {
      if (!state.providers[id]) throw new Error('provider not found');
      const previous = new Map((state.providers[id].models || []).map((model) => [model.id, model]));
      state.providers[id].models = models.map((model) => {
        const probe = previous.get(model.id)?.probe;
        return probe && !model.probe ? { ...model, probe } : model;
      });
      state.providers[id].refreshedAt = refreshedAt;
      return state;
    });
    return publicProvider(await this.provider(id));
  }

  async setModelProbe(providerId, modelId, probe) {
    await this.update((state) => {
      const provider = state.providers[providerId];
      if (!provider) throw new Error('provider not found');
      const model = (provider.models || []).find((entry) => entry.id === modelId);
      if (!model) throw new Error('model not found');
      model.probe = probe && typeof probe === 'object' ? structuredClone(probe) : null;
      return state;
    });
    return (await this.provider(providerId))?.models?.find((entry) => entry.id === modelId) || null;
  }

  async getSession(threadId = '') {
    const state = await this.read();
    const id = String(threadId || '');
    if (id && validSessionId(id) && state.sessions[id]) {
      return { threadId: id, explicit: true, ...normalizeSession(state.sessions[id], state.defaultProfile) };
    }
    return {
      threadId: id || null,
      explicit: false,
      mode: state.defaultMode,
      profile: normalizeProfile(state.defaultProfile),
      updatedAt: null
    };
  }

  async setSessionMode(threadId, mode) {
    const normalized = normalizeMode(mode);
    if (String(mode || '').toUpperCase() !== normalized) throw new Error('mode must be NATIVE or WORKER');
    const id = String(threadId || '');
    await this.update((state) => {
      if (!id) {
        state.defaultMode = normalized;
        return state;
      }
      if (!validSessionId(id)) throw new Error('invalid session thread id');
      const current = normalizeSession(state.sessions[id], state.defaultProfile);
      state.sessions[id] = { ...current, mode: normalized, updatedAt: new Date().toISOString() };
      return state;
    });
    return this.getSession(id);
  }

  async getProfile(threadId = '') { return (await this.getSession(threadId)).profile; }

  async setProfile(profile, threadId = '') {
    const id = String(threadId || '');
    const current = await this.getProfile(id);
    const next = normalizeProfile({ ...current, ...(profile || {}) });
    await this.update((state) => {
      if (!id) {
        state.defaultProfile = next;
        return state;
      }
      if (!validSessionId(id)) throw new Error('invalid session thread id');
      const session = normalizeSession(state.sessions[id], state.defaultProfile);
      state.sessions[id] = { ...session, profile: next, updatedAt: new Date().toISOString() };
      return state;
    });
    return next;
  }

  async setOverride(providerId, modelId, override) {
    await this.update((state) => {
      state.overrides[providerId] ||= {};
      if (override) state.overrides[providerId][modelId] = override;
      else delete state.overrides[providerId][modelId];
      return state;
    });
    return { providerId, modelId, override: override || null };
  }

  async overridesFor(providerId) { return (await this.read()).overrides?.[providerId] || {}; }

  async createRoute({ providerId, modelId, reasoning, capability }) {
    const alias = `dw_${crypto.randomBytes(12).toString('base64url')}`;
    const createdAt = new Date().toISOString();
    await this.update((state) => {
      state.routes[alias] = {
        alias, providerId, modelId, reasoning: reasoning || 'auto', capability: capability || null,
        createdAt, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      };
      const cutoff = Date.now();
      for (const [key, route] of Object.entries(state.routes)) if (Date.parse(route.expiresAt || 0) < cutoff) delete state.routes[key];
      return state;
    });
    return alias;
  }

  async route(alias) {
    const route = (await this.read()).routes?.[alias] || null;
    if (!route || Date.parse(route.expiresAt || 0) < Date.now()) return null;
    return route;
  }

  async protocol(providerId, modelId) { return (await this.read()).protocolCache?.[`${providerId}:${modelId}`] || null; }
  async setProtocol(providerId, modelId, protocol) {
    await this.update((state) => {
      state.protocolCache[`${providerId}:${modelId}`] = { protocol, detectedAt: new Date().toISOString() };
      return state;
    });
  }

  publicProvider(provider) { return publicProvider(provider); }
}