import { normalizeBaseUrl, listProviderModels, probeProtocol } from './provider.mjs';
import { reasoningSelection } from './capabilities.mjs';

function safeModel(model) {
  if (!model) return null;
  const { raw, ...safe } = model;
  return safe;
}

function threadId(context = {}) { return String(context.threadId || ''); }

export class DelegationRuntime {
  constructor({ store, vault, workerManager, codexConfig, gateway, fetchImpl = fetch } = {}) {
    this.store = store;
    this.vault = vault;
    this.workerManager = workerManager;
    this.codexConfig = codexConfig;
    this.gateway = gateway;
    this.fetchImpl = fetchImpl;
  }

  async status(context = {}) {
    const id = threadId(context);
    const [providers, session, codex] = await Promise.all([
      this.store.listProviders(),
      this.store.getSession(id),
      this.codexConfig.status()
    ]);
    const active = await this.workerManager.currentForSupervisor(id);
    return {
      version: '0.2.0',
      session,
      profile: session.profile,
      mode: session.mode,
      providers: providers.map((p) => ({
        id: p.id, name: p.name, baseUrl: p.baseUrl, adapter: p.adapter,
        apiKeyConfigured: p.apiKeyConfigured, modelCount: p.models?.length || 0, refreshedAt: p.refreshedAt
      })),
      activeWorker: active,
      codex,
      gateway: { port: Number(process.env.DWMCP_GATEWAY_PORT || 8791) }
    };
  }

  async catalog({ refresh = false } = {}, context = {}) {
    if (refresh) {
      const providers = await this.store.listProviders();
      await Promise.allSettled(providers.map((provider) => this.refreshProvider(provider.id)));
    }
    const [providers, session] = await Promise.all([
      this.store.listProviders(),
      this.store.getSession(threadId(context))
    ]);
    return {
      mode: session.mode,
      session,
      profile: session.profile,
      providers: providers.map((provider) => ({
        id: provider.id, name: provider.name, baseUrl: provider.baseUrl, adapter: provider.adapter,
        apiKeyConfigured: provider.apiKeyConfigured, refreshedAt: provider.refreshedAt,
        models: (provider.models || []).map(safeModel)
      }))
    };
  }

  async getMode(context = {}) { return this.store.getSession(threadId(context)); }

  async setMode({ mode } = {}, context = {}) {
    const id = threadId(context);
    const current = await this.store.getSession(id);
    const nextMode = String(mode || '').toUpperCase();
    if (nextMode === 'NATIVE' && current.mode === 'WORKER') {
      await this.workerManager.cancelForSupervisor(id, 'session switched to NATIVE mode');
    }
    return this.store.setSessionMode(id, nextMode);
  }

  async saveProvider({ id = '', name, baseUrl, apiKey, adapter = 'openai-compatible', authType = 'bearer', headerName = null, headers = null } = {}) {
    const normalized = normalizeBaseUrl(baseUrl);
    const existing = id ? await this.store.provider(id) : null;
    const cipher = apiKey !== undefined && String(apiKey) !== '' ? await this.vault.encrypt(String(apiKey)) : (existing?.apiKeyCipher || '');
    const provider = await this.store.saveProvider({ id, name, baseUrl: normalized, adapter, authType, headerName, headers, apiKeyCipher: cipher });
    try {
      await this.refreshProvider(provider.id);
      return { provider: (await this.store.listProviders()).find((item) => item.id === provider.id), tested: true };
    } catch (error) {
      return { provider: (await this.store.listProviders()).find((item) => item.id === provider.id), tested: false, error: String(error.message || error) };
    }
  }

  async deleteProvider(id) { return this.store.deleteProvider(String(id || '')); }

  async refreshProvider(id) {
    const provider = await this.store.provider(id);
    if (!provider) throw new Error('provider not found');
    if (provider.adapter !== 'openai-compatible') throw new Error(`provider adapter ${provider.adapter} is not implemented yet`);
    const key = provider.apiKeyCipher ? await this.vault.decrypt(provider.apiKeyCipher) : '';
    const overrides = await this.store.overridesFor(id);
    const models = await listProviderModels({ provider, apiKey: key, overrides, fetchImpl: this.fetchImpl });
    await this.store.setProviderModels(id, models);
    return { id, models: models.map(safeModel), count: models.length };
  }

  async probeProvider(id, modelId = '') {
    const provider = await this.store.provider(id);
    if (!provider) throw new Error('provider not found');
    const model = modelId || provider.models?.[0]?.id;
    if (!model) throw new Error('provider has no model to probe');
    const key = provider.apiKeyCipher ? await this.vault.decrypt(provider.apiKeyCipher) : '';
    const result = await probeProtocol({ provider, apiKey: key, model, fetchImpl: this.fetchImpl });
    if (result.ok && ['responses', 'chat'].includes(result.protocol)) await this.store.setProtocol(id, model, result.protocol);
    return { providerId: id, modelId: model, ...result };
  }

  async getProfile(context = {}) { return this.store.getProfile(threadId(context)); }

  async setProfile(input = {}, context = {}) {
    const provider = await this.store.provider(input.providerId);
    if (!provider) throw new Error('provider is required');
    const model = provider.models?.find((entry) => entry.id === input.modelId);
    if (!model) throw new Error('model is not present in the current provider catalog');
    const reasoning = reasoningSelection(model.reasoning, input.reasoning || 'auto');
    if (String(input.reasoning || 'auto') !== reasoning) throw new Error('selected reasoning value is not advertised by this provider/model');
    return this.store.setProfile({
      providerId: provider.id,
      modelId: model.id,
      reasoning,
      access: input.access || 'danger-full-access',
      autoVerify: input.autoVerify !== false,
      autoExtend: input.autoExtend !== false,
      leaseMs: input.leaseMs,
      maxTotalMs: input.maxTotalMs
    }, threadId(context));
  }

  async setModelOverride({ providerId, modelId, override = null } = {}) {
    const provider = await this.store.provider(providerId);
    if (!provider) throw new Error('provider not found');
    await this.store.setOverride(providerId, modelId, override);
    await this.refreshProvider(providerId);
    return { providerId, modelId, override };
  }

  async codexInstall() {
    await this.store.gatewayToken();
    await this.gateway.start();
    return this.codexConfig.install();
  }
  async codexStatus() { return this.codexConfig.status(); }

  async workerStart(args, context = {}) { return this.workerManager.start({ ...args, supervisorThreadId: threadId(context) }); }
  async workerStatus(args, context = {}) { return this.workerManager.status(String(args.taskId || ''), threadId(context)); }
  async workerWait(args, context = {}) { return this.workerManager.wait(String(args.taskId || ''), args.waitMs, threadId(context)); }
  async workerSteer(args, context = {}) { return this.workerManager.steer(String(args.taskId || ''), String(args.direction || ''), threadId(context)); }
  async workerExtend(args, context = {}) { return this.workerManager.extend(String(args.taskId || ''), { extraMs: args.extraMs, reason: args.reason }, threadId(context)); }
  async workerRespond(args, context = {}) { return this.workerManager.respond(String(args.taskId || ''), args, threadId(context)); }
  async workerCancel(args, context = {}) { return this.workerManager.cancel(String(args.taskId || ''), String(args.reason || 'cancelled by operator'), threadId(context)); }
}
