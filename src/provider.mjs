import { publicModel } from './capabilities.mjs';

const MAX_BODY = 8 * 1024 * 1024;
const MAX_ERROR = 64 * 1024;
const MAX_MODELS = 4000;
const UNSUPPORTED_CODES = new Set([404, 405, 410, 501]);
const UNSUPPORTED_PATTERNS = [/not\s+found/i, /unsupported.*(?:endpoint|api|responses)/i, /unknown.*(?:endpoint|path)/i, /responses.*(?:not supported|unsupported|disabled)/i, /no route/i];
const PROTOCOL_MISMATCH_PATTERNS = [/missing\s+(?:required\s+)?(?:parameter|field).*messages/i, /messages.*(?:missing|required)/i, /stream\s+must\s+be\s+set\s+to\s+true/i, /invalid\s+input\s+type/i, /convert_request_failed/i, /not\s+implemented/i];

function withPath(url, pathname) { const out = new URL(url); out.pathname = pathname || '/'; out.search = ''; out.hash = ''; return out.toString(); }

export function normalizeBaseUrl(value) {
  const url = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('provider URL must use http or https');
  if (url.username || url.password) throw new Error('provider URL must not contain credentials');
  url.search = ''; url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString().replace(/\/$/, '');
}

export function endpoints(baseUrl) {
  const url = new URL(normalizeBaseUrl(baseUrl));
  let p = url.pathname.replace(/\/+$/, '');
  if (p.endsWith('/v1/responses')) p = p.slice(0, -'/responses'.length);
  else if (p.endsWith('/v1/chat/completions')) p = p.slice(0, -'/chat/completions'.length);
  else if (p.endsWith('/v1/models')) p = p.slice(0, -'/models'.length);
  else if (p.endsWith('/v1/embeddings')) p = p.slice(0, -'/embeddings'.length);
  if (!p.endsWith('/v1')) p = `${p}/v1`.replace(/^\/\//, '/');
  return {
    apiRoot: withPath(url, p),
    models: withPath(url, `${p}/models`),
    responses: withPath(url, `${p}/responses`),
    chat: withPath(url, `${p}/chat/completions`),
    embeddings: withPath(url, `${p}/embeddings`)
  };
}

export function authHeaders(provider, apiKey) {
  const out = { 'content-type': 'application/json' };
  if (apiKey) {
    if (provider?.authType === 'header' && provider?.headerName) out[String(provider.headerName)] = apiKey;
    else out.authorization = `Bearer ${apiKey}`;
  }
  for (const [name, value] of Object.entries(provider?.headers || {})) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || /^(authorization|proxy-authorization|content-length|host|connection|cookie|set-cookie)$/i.test(name)) continue;
    const text = String(value ?? '');
    if (text.length <= 8192 && !/[\0\r\n]/.test(text)) out[name] = text;
  }
  return out;
}

async function readLimited(response, limit) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new Error(`provider response exceeds ${limit} bytes`);
  if (!response.body) return '';
  const chunks = []; let total = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk); total += bytes.length;
    if (total > limit) { await response.body.cancel?.().catch?.(() => {}); throw new Error(`provider response exceeds ${limit} bytes`); }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function trimError(value) { return String(value || '').replace(/\s+/g, ' ').slice(0, 600); }
export function unsupportedEndpoint(status, body = '') { return UNSUPPORTED_CODES.has(status) || UNSUPPORTED_PATTERNS.some((pattern) => pattern.test(body)); }
export function shouldTryChatFallback(status, body = '') { return unsupportedEndpoint(status, body) || (status >= 500 && status <= 503) || (status !== 401 && status !== 403 && PROTOCOL_MISMATCH_PATTERNS.some((pattern) => pattern.test(body))); }

export async function listProviderModels({ provider, apiKey, fetchImpl = fetch, timeoutMs = 15000, overrides = {} }) {
  const ep = endpoints(provider.baseUrl);
  const response = await fetchImpl(ep.models, { method: 'GET', headers: authHeaders(provider, apiKey), signal: AbortSignal.timeout(timeoutMs) });
  const text = await readLimited(response, response.ok ? MAX_BODY : MAX_ERROR);
  if (!response.ok) throw new Error(`model listing failed (${response.status}): ${trimError(text)}`);
  let parsed; try { parsed = JSON.parse(text); } catch { throw new Error('model listing did not return JSON'); }
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed?.models) ? parsed.models : [];
  if (rows.length > MAX_MODELS) throw new Error(`model listing returned more than ${MAX_MODELS} models`);
  const seen = new Set(); const models = [];
  for (const row of rows) {
    const raw = typeof row === 'string' ? { id: row } : row;
    const model = publicModel(raw, { override: overrides?.[String(raw?.id ?? raw?.model ?? raw?.name ?? '')] || null });
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id); models.push(model);
  }
  return models;
}

async function probeResponsesToolAcceptance({ provider, apiKey, model, tools, fetchImpl = fetch, timeoutMs = 15000 }) {
  const ep = endpoints(provider.baseUrl);
  const response = await fetchImpl(ep.responses, {
    method: 'POST',
    headers: authHeaders(provider, apiKey),
    body: JSON.stringify({
      model,
      input: 'Use the provided probe tool exactly once, then stop.',
      tools,
      max_output_tokens: 16,
      stream: true
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (response.ok) {
    await response.body?.cancel?.().catch?.(() => {});
    return { supported: true, status: response.status, error: null };
  }
  const errorText = await readLimited(response, MAX_ERROR);
  const definitelyUnsupported = [400, 404, 405, 409, 415, 422, 501].includes(response.status);
  return {
    supported: definitelyUnsupported ? false : null,
    status: response.status,
    error: trimError(errorText)
  };
}

export async function probeProtocol({ provider, apiKey, model, fetchImpl = fetch, timeoutMs = 15000 }) {
  const ep = endpoints(provider.baseUrl);
  const headers = authHeaders(provider, apiKey);
  const responseBody = { model, input: 'Reply only OK', max_output_tokens: 1, stream: true };
  const rr = await fetchImpl(ep.responses, { method: 'POST', headers, body: JSON.stringify(responseBody), signal: AbortSignal.timeout(timeoutMs) });
  if (rr.ok) { await rr.body?.cancel?.().catch?.(() => {}); return { protocol: 'responses', status: rr.status, ok: true }; }
  const rrText = await readLimited(rr, MAX_ERROR);
  if (!shouldTryChatFallback(rr.status, rrText)) return { protocol: 'responses', status: rr.status, ok: false, error: trimError(rrText) };
  const chatBody = { model, messages: [{ role: 'user', content: 'Reply only OK' }], max_tokens: 1, stream: true };
  const cr = await fetchImpl(ep.chat, { method: 'POST', headers, body: JSON.stringify(chatBody), signal: AbortSignal.timeout(timeoutMs) });
  if (cr.ok) { await cr.body?.cancel?.().catch?.(() => {}); return { protocol: 'chat', status: cr.status, ok: true, responsesStatus: rr.status }; }
  const crText = await readLimited(cr, MAX_ERROR);
  return { protocol: 'unknown', status: cr.status, ok: false, responsesStatus: rr.status, error: trimError(crText) };
}

export async function probeCodexCompatibility({ provider, apiKey, model, fetchImpl = fetch, timeoutMs = 15000 }) {
  const protocol = await probeProtocol({ provider, apiKey, model, fetchImpl, timeoutMs });
  if (!protocol.ok || protocol.protocol !== 'responses') {
    return {
      ...protocol,
      grade: protocol.protocol === 'chat' ? 'chat-compatibility' : 'unavailable',
      codex: {
        functionTools: null,
        customTools: false,
        mcpTools: null,
        parallelToolCalls: null
      },
      probedAt: new Date().toISOString()
    };
  }

  const functionProbe = await probeResponsesToolAcceptance({
    provider, apiKey, model, fetchImpl, timeoutMs,
    tools: [{
      type: 'function',
      name: 'dwmcp_probe_function',
      description: 'Compatibility probe. Call this function exactly once.',
      strict: false,
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false
      }
    }]
  });

  const customProbe = await probeResponsesToolAcceptance({
    provider, apiKey, model, fetchImpl, timeoutMs,
    tools: [{
      type: 'custom',
      name: 'dwmcp_probe_custom',
      description: 'Compatibility probe. Emit exactly OK.',
      format: { type: 'grammar', syntax: 'lark', definition: 'start: "OK"' }
    }]
  });

  const functionTools = functionProbe.supported;
  const customTools = customProbe.supported;
  return {
    ...protocol,
    grade: functionTools === true && customTools === true
      ? 'full-candidate'
      : (functionTools === true ? 'responses-function' : 'responses-basic'),
    codex: {
      functionTools,
      customTools,
      mcpTools: functionTools,
      parallelToolCalls: null
    },
    probes: { function: functionProbe, custom: customProbe },
    probedAt: new Date().toISOString()
  };
}

export function applyReasoningToResponses(body, capability, selected) {
  const value = selected || 'auto';
  if (!capability || value === 'auto' || capability.kind === 'unknown') return { ...body };
  const next = structuredClone(body);
  switch (capability.requestStyle) {
    case 'openai_reasoning':
      next.reasoning = { ...(next.reasoning || {}), effort: value };
      break;
    case 'thinking_flag':
      next.thinking = ['on', 'enabled', 'true'].includes(String(value).toLowerCase());
      break;
    case 'thinking_mode':
      next.thinking = value;
      break;
    case 'thinking_budget':
      next.thinking = { type: 'enabled', budget_tokens: Number(value) };
      break;
    default:
      break;
  }
  return next;
}

export function applyReasoningToChat(body, capability, selected) {
  const value = selected || 'auto';
  if (!capability || value === 'auto' || capability.kind === 'unknown') return { ...body };
  const next = structuredClone(body);
  switch (capability.requestStyle) {
    case 'openai_reasoning': next.reasoning_effort = value; break;
    case 'thinking_flag': next.thinking = ['on', 'enabled', 'true'].includes(String(value).toLowerCase()); break;
    case 'thinking_mode': next.thinking = value; break;
    case 'thinking_budget': next.thinking = { type: 'enabled', budget_tokens: Number(value) }; break;
    default: break;
  }
  return next;
}

export { readLimited };