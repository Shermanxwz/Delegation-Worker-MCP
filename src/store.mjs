import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { atomicWrite, readJsonFile, withFileLock } from './atomic.mjs';
import { gatewayTokenPath, statePath } from './paths.mjs';

const EMPTY = {
  schemaVersion: 1,
  providers: {},
  profile: {
    enabled: false,
    providerId: '',
    modelId: '',
    reasoning: 'auto',
    access: 'danger-full-access',
    autoVerify: true
  },
  routes: {},
  overrides: {},
  protocolCache: {},
  updatedAt: null
};

function cleanState(value) {
  const state = value && typeof value === 'object' ? value : {};
  return {
    ...structuredClone(EMPTY),
    ...state,
    providers: state.providers && typeof state.providers === 'object' ? state.providers : {},
    routes: state.routes && typeof state.routes === 'object' ? state.routes : {},
    overrides: state.overrides && typeof state.overrides === 'object' ? state.overrides : {},
    protocolCache: state.protocolCache && typeof state.protocolCache === 'object' ? state.protocolCache : {},
    profile: { ...EMPTY.profile, ...(state.profile || {}) }
  };
}

function publicProvider(provider) {
  if (!provider) return null;
  const { apiKeyCipher, ...safe } = provider;
  return { ...safe, apiKeyConfigured: Boolean(apiKeyCipher) };
}

export class StateStore {
  constructor({ env = process.env } = {}) { this.env = env; this.file = statePath(env); this.tokenFile = gatewayTokenPath(env); }

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

  async provider(id) { const state = await this.read(); return state.providers[id] || null; }

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
      if (state.profile.providerId === id) state.profile = { ...EMPTY.profile };
      return state;
    });
    return { removed: true, id };
  }

  async setProviderModels(id, models) {
    const refreshedAt = new Date().toISOString();
    await this.update((state) => {
      if (!state.providers[id]) throw new Error('provider not found');
      state.providers[id].models = models;
      state.providers[id].refreshedAt = refreshedAt;
      return state;
    });
    return publicProvider(await this.provider(id));
  }

  async getProfile() { return (await this.read()).profile; }

  async setProfile(profile) {
    const next = { ...EMPTY.profile, ...(await this.getProfile()), ...(profile || {}) };
    if (!['danger-full-access', 'workspace-write', 'read-only'].includes(next.access)) throw new Error('invalid worker access');
    next.enabled = Boolean(next.enabled);
    next.autoVerify = Boolean(next.autoVerify);
    next.reasoning = String(next.reasoning || 'auto').slice(0, 128);
    await this.update((state) => { state.profile = next; return state; });
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
      state.routes[alias] = { alias, providerId, modelId, reasoning: reasoning || 'auto', capability: capability || null, createdAt, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() };
      const cutoff = Date.now();
      for (const [key, route] of Object.entries(state.routes)) if (Date.parse(route.expiresAt || 0) < cutoff) delete state.routes[key];
      return state;
    });
    return alias;
  }

  async route(alias) {
    const route = (await this.read()).routes?.[alias] || null;
    if (!route) return null;
    if (Date.parse(route.expiresAt || 0) < Date.now()) return null;
    return route;
  }

  async protocol(providerId, modelId) { return (await this.read()).protocolCache?.[`${providerId}:${modelId}`] || null; }
  async setProtocol(providerId, modelId, protocol) {
    await this.update((state) => { state.protocolCache[`${providerId}:${modelId}`] = { protocol, detectedAt: new Date().toISOString() }; return state; });
  }

  publicProvider(provider) { return publicProvider(provider); }
}
