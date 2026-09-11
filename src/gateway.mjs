import http from 'node:http';
import { applyReasoningToChat, applyReasoningToResponses, authHeaders, endpoints, readLimited, shouldTryChatFallback } from './provider.mjs';
import { chatJsonToResponses, convertChatSse, responsesToChat } from './translate.mjs';
import { codexModelInfoForRoute, loadCodexBaseInstructions } from './codex-model-info.mjs';

const BODY_LIMIT = 16 * 1024 * 1024;
const ERROR_LIMIT = 64 * 1024;

async function readRequestJson(req) {
  let total = 0; const chunks = [];
  for await (const chunk of req) { total += chunk.length; if (total > BODY_LIMIT) throw Object.assign(new Error('request too large'), { statusCode: 413 }); chunks.push(Buffer.from(chunk)); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('invalid JSON'), { statusCode: 400 }); }
}

function json(res, status, body) { if (res.writableEnded || res.destroyed) return; res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
async function backpressure(res, chunk) { if (!chunk || res.writableEnded || res.destroyed) return; if (res.write(chunk)) return; await new Promise((resolve, reject) => { const done = () => { cleanup(); resolve(); }, fail = (e) => { cleanup(); reject(e); }, cleanup = () => { res.off('drain', done); res.off('close', done); res.off('error', fail); }; res.once('drain', done); res.once('close', done); res.once('error', fail); }); }
async function pipe(upstream, res) { const headers = {}; for (const key of ['content-type', 'cache-control', 'x-request-id']) { const value = upstream.headers.get(key); if (value) headers[key] = value; } res.writeHead(upstream.status, headers); if (!upstream.body) return res.end(); for await (const chunk of upstream.body) await backpressure(res, chunk); if (!res.writableEnded && !res.destroyed) res.end(); }

export class ModelGateway {
  constructor({ store, vault, env = process.env, fetchImpl = fetch } = {}) {
    this.store = store; this.vault = vault; this.env = env; this.fetchImpl = fetchImpl; this.host = '127.0.0.1'; this.port = Number(env.DWMCP_GATEWAY_PORT || 8791); this.server = null; this.owned = false;
  }

  async start() {
    if (this.server || this.owned) return { owned: this.owned, port: this.port };
    await this.store.gatewayToken();
    const server = http.createServer((req, res) => this.#handle(req, res).catch((error) => json(res, error.statusCode || 500, { error: { message: String(error.message || error), type: 'delegation_worker_error' } })));
    try {
      await new Promise((resolve, reject) => { const onError = (error) => { server.off('listening', onListen); reject(error); }, onListen = () => { server.off('error', onError); resolve(); }; server.once('error', onError); server.once('listening', onListen); server.listen(this.port, this.host); });
      this.server = server; this.owned = true; return { owned: true, port: this.port };
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      server.close();
      if (await this.#existingHealthy()) return { owned: false, port: this.port };
      throw new Error(`gateway port ${this.port} is already in use by another process`);
    }
  }

  async close() { if (!this.server) return; const server = this.server; this.server = null; this.owned = false; await new Promise((resolve) => server.close(() => resolve())); }

  async #existingHealthy() {
    try { const token = await this.store.gatewayToken(); const response = await this.fetchImpl(`http://${this.host}:${this.port}/health`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1500) }); const body = await response.json(); return response.ok && body?.service === 'delegation-worker-mcp'; } catch { return false; }
  }

  async #authorized(req) { const token = await this.store.gatewayToken(); return String(req.headers.authorization || '') === `Bearer ${token}`; }

  async #handle(req, res) {
    if (!await this.#authorized(req)) return json(res, 401, { error: { message: 'invalid gateway token', type: 'authentication_error' } });
    const url = new URL(req.url || '/', `http://${req.headers.host || `${this.host}:${this.port}`}`);
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, service: 'delegation-worker-mcp', version: '0.3.0' });
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      const state = await this.store.read();
      const baseInstructions = await loadCodexBaseInstructions();
      const models = [];
      for (const route of Object.values(state.routes)) {
        if (Date.parse(route.expiresAt || 0) <= Date.now()) continue;
        const provider = state.providers?.[route.providerId];
        const model = provider?.models?.find((entry) => entry.id === route.modelId);
        if (!model) continue;
        models.push(codexModelInfoForRoute({ route, model, baseInstructions }));
      }
      return json(res, 200, { models });
    }
    if (req.method === 'POST' && url.pathname === '/v1/responses') return this.#responses(req, res, await readRequestJson(req));
    return json(res, 404, { error: { message: 'not found', type: 'not_found' } });
  }

  async #responses(req, res, body) {
    const alias = String(body.model || ''); const route = await this.store.route(alias); if (!route) return json(res, 400, { error: { message: 'unknown or expired Worker model route', type: 'invalid_request_error' } });
    const provider = await this.store.provider(route.providerId); if (!provider) return json(res, 503, { error: { message: 'Worker provider is unavailable', type: 'configuration_error' } });
    if (provider.adapter !== 'openai-compatible') return json(res, 501, { error: { message: `provider adapter ${provider.adapter} is not implemented`, type: 'unsupported_provider' } });
    const apiKey = provider.apiKeyCipher ? await this.vault.decrypt(provider.apiKeyCipher) : '';
    const headers = authHeaders(provider, apiKey); const ep = endpoints(provider.baseUrl); const model = route.modelId; const capability = route.capability;
    let next = { ...body, model }; next = applyReasoningToResponses(next, capability, route.reasoning);
    const cached = await this.store.protocol(provider.id, model); const preferred = provider.protocol && provider.protocol !== 'auto' ? provider.protocol : cached?.protocol;
    if (preferred === 'chat') return this.#chat(res, next, route, provider, headers, ep.chat);
    if (preferred === 'responses') return pipe(await this.fetchImpl(ep.responses, { method: 'POST', headers, body: JSON.stringify(next), signal: AbortSignal.timeout(65 * 60 * 1000) }), res);
    const upstream = await this.fetchImpl(ep.responses, { method: 'POST', headers, body: JSON.stringify(next), signal: AbortSignal.timeout(65 * 60 * 1000) });
    if (upstream.ok) { await this.store.setProtocol(provider.id, model, 'responses'); return pipe(upstream, res); }
    const errorText = await readLimited(upstream, ERROR_LIMIT);
    if (!shouldTryChatFallback(upstream.status, errorText)) { res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' }); return res.end(errorText); }
    await this.store.setProtocol(provider.id, model, 'chat');
    return this.#chat(res, next, route, provider, headers, ep.chat);
  }

  async #chat(res, responsesBody, route, provider, headers, url) {
    let chatBody = responsesToChat(responsesBody); chatBody = applyReasoningToChat(chatBody, route.capability, route.reasoning);
    const upstream = await this.fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(chatBody), signal: AbortSignal.timeout(65 * 60 * 1000) });
    if (!upstream.ok) return pipe(upstream, res);
    if (responsesBody.stream === false) {
      const text = await readLimited(upstream, BODY_LIMIT); let parsed; try { parsed = JSON.parse(text); } catch { return json(res, 502, { error: { message: 'upstream chat response was not JSON', type: 'upstream_error' } }); }
      return json(res, 200, await chatJsonToResponses(parsed, route.modelId));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    await convertChatSse(upstream.body, (chunk) => backpressure(res, chunk), { model: route.modelId });
    if (!res.writableEnded && !res.destroyed) res.end();
  }
}