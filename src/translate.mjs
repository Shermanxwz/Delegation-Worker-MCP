import crypto from 'node:crypto';

const MAX_SSE_BLOCK = 2 * 1024 * 1024;
const MAX_TEXT = 16 * 1024 * 1024;
const MAX_TOOL_ARGUMENTS = 8 * 1024 * 1024;

function id(prefix) { return `${prefix}_${crypto.randomBytes(10).toString('hex')}`; }
function bytes(value) { return Buffer.byteLength(String(value || ''), 'utf8'); }
function sse(value) { return `data: ${JSON.stringify(value)}\n\n`; }

function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((p) => ['input_text', 'output_text', 'text'].includes(p?.type)).map((p) => p.text || '').join('');
}

function chatContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (['input_text', 'output_text', 'text'].includes(part?.type)) parts.push({ type: 'text', text: part.text || '' });
    else if (part?.type === 'input_image' && part.image_url) parts.push({ type: 'image_url', image_url: { url: part.image_url } });
  }
  return parts.length === 1 && parts[0].type === 'text' ? parts[0].text : (parts.length ? parts : textContent(content));
}

export function responsesToChat(body) {
  const messages = [];
  if (body.instructions) messages.push({ role: 'system', content: String(body.instructions) });
  const input = typeof body.input === 'string' ? [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: body.input }] }] : (body.input || []);
  let assistant = null;
  const flush = () => { if (!assistant) return; if (!assistant.tool_calls?.length) delete assistant.tool_calls; messages.push(assistant); assistant = null; };
  for (const item of input) {
    if (item?.type === 'message' || (!item?.type && item?.role)) {
      const role = item.role === 'developer' ? 'system' : (item.role || 'user');
      if (role === 'assistant') { flush(); assistant = { role, content: chatContent(item.content), tool_calls: [] }; }
      else { flush(); messages.push({ role, content: chatContent(item.content) }); }
    } else if (item?.type === 'function_call') {
      assistant ||= { role: 'assistant', content: null, tool_calls: [] };
      assistant.tool_calls.push({ id: item.call_id || item.id, type: 'function', function: { name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}) } });
    } else if (item?.type === 'function_call_output') {
      flush(); messages.push({ role: 'tool', tool_call_id: item.call_id, content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '') });
    }
  }
  flush();
  const tools = (body.tools || []).filter((t) => t?.type === 'function').map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters || {}, ...(t.strict !== undefined ? { strict: t.strict } : {}) } }));
  const result = { model: body.model, messages, stream: body.stream !== false };
  if (tools.length) result.tools = tools;
  if (body.tool_choice !== undefined) result.tool_choice = body.tool_choice;
  if (body.max_output_tokens) result.max_tokens = body.max_output_tokens;
  if (result.stream) result.stream_options = { include_usage: true };
  return result;
}

export async function chatJsonToResponses(response, model) {
  const output = [];
  const message = response.choices?.[0]?.message || {};
  if (message.content) output.push({ id: id('msg'), type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: String(message.content), annotations: [] }] });
  for (const tc of message.tool_calls || []) output.push({ id: id('fc'), type: 'function_call', call_id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments || '{}', status: 'completed' });
  const usage = response.usage || {};
  return { id: id('resp'), object: 'response', status: 'completed', model, output, usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0, total_tokens: usage.total_tokens || 0, input_tokens_details: { cached_tokens: usage.prompt_tokens_details?.cached_tokens || 0 }, output_tokens_details: { reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens || 0 } } };
}

class StreamConverter {
  constructor(model) { this.model = model; this.responseId = id('resp'); this.messageId = id('msg'); this.text = ''; this.textBytes = 0; this.toolBytes = 0; this.tools = new Map(); this.usage = null; this.started = false; this.done = false; }
  start() { if (this.started) return ''; this.started = true; return sse({ type: 'response.created', response: { id: this.responseId, object: 'response', status: 'in_progress', model: this.model, output: [] } }); }
  data(raw) {
    if (raw === '[DONE]') return this.finish();
    let chunk; try { chunk = JSON.parse(raw); } catch { return ''; }
    let out = this.start(); if (chunk.usage) this.usage = chunk.usage;
    const delta = chunk.choices?.[0]?.delta || {};
    if (typeof delta.content === 'string' && delta.content) {
      this.textBytes += bytes(delta.content); if (this.textBytes > MAX_TEXT) throw new Error('upstream text too large');
      this.text += delta.content;
      out += sse({ type: 'response.output_text.delta', item_id: this.messageId, output_index: 0, content_index: 0, delta: delta.content });
    }
    for (const tc of delta.tool_calls || []) {
      const index = tc.index ?? 0; const current = this.tools.get(index) || { id: tc.id || id('call'), name: '', arguments: '' };
      if (tc.id) current.id = tc.id;
      if (tc.function?.name) current.name += tc.function.name;
      if (tc.function?.arguments) { this.toolBytes += bytes(tc.function.arguments); if (this.toolBytes > MAX_TOOL_ARGUMENTS) throw new Error('upstream tool arguments too large'); current.arguments += tc.function.arguments; }
      this.tools.set(index, current);
    }
    return out;
  }
  finish() {
    if (this.done) return ''; this.done = true; let out = this.start(); let index = 0;
    if (this.text) out += sse({ type: 'response.output_item.done', output_index: index++, item: { id: this.messageId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: this.text, annotations: [] }] } });
    for (const [, tool] of [...this.tools.entries()].sort(([a], [b]) => a - b)) out += sse({ type: 'response.output_item.done', output_index: index++, item: { id: id('fc'), type: 'function_call', call_id: tool.id, name: tool.name, arguments: tool.arguments, status: 'completed' } });
    const u = this.usage || {}; const input = Number(u.prompt_tokens || 0), output = Number(u.completion_tokens || 0);
    out += sse({ type: 'response.completed', response: { id: this.responseId, object: 'response', status: 'completed', model: this.model, output: [], usage: { input_tokens: input, output_tokens: output, total_tokens: Number(u.total_tokens || input + output), input_tokens_details: { cached_tokens: u.prompt_tokens_details?.cached_tokens || 0 }, output_tokens_details: { reasoning_tokens: u.completion_tokens_details?.reasoning_tokens || 0 } } } });
    return out;
  }
}

export async function convertChatSse(readable, onChunk, { model }) {
  const converter = new StreamConverter(model); await onChunk(converter.start());
  const decoder = new TextDecoder(); let buffer = '';
  for await (const chunk of readable) {
    buffer += decoder.decode(chunk, { stream: true });
    if (bytes(buffer) > MAX_SSE_BLOCK && !/\r?\n\r?\n/.test(buffer)) throw new Error('upstream SSE block too large');
    while (true) {
      const match = /\r?\n\r?\n/.exec(buffer); if (!match) break;
      const block = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
      for (const line of block.split(/\r?\n/)) if (line.startsWith('data:')) { const value = converter.data(line.slice(5).trim()); if (value) await onChunk(value); }
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) for (const line of buffer.split(/\r?\n/)) if (line.startsWith('data:')) { const value = converter.data(line.slice(5).trim()); if (value) await onChunk(value); }
  const final = converter.finish(); if (final) await onChunk(final);
}
