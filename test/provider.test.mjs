import test from 'node:test';
import assert from 'node:assert/strict';
import { endpoints, applyReasoningToResponses, applyReasoningToChat, probeCodexCompatibility } from '../src/provider.mjs';

test('provider endpoint normalization accepts roots and concrete endpoints', () => {
  assert.equal(endpoints('https://example.com').models, 'https://example.com/v1/models');
  assert.equal(endpoints('https://example.com/v1/chat/completions').responses, 'https://example.com/v1/responses');
  assert.equal(endpoints('https://example.com/v1/responses').chat, 'https://example.com/v1/chat/completions');
});

test('reasoning injection follows normalized capability instead of model name', () => {
  const effort = { kind: 'effort', requestStyle: 'openai_reasoning' };
  assert.equal(applyReasoningToResponses({ model: 'x' }, effort, 'high').reasoning.effort, 'high');
  assert.equal(applyReasoningToChat({ model: 'x' }, effort, 'high').reasoning_effort, 'high');
  const toggle = { kind: 'toggle', requestStyle: 'thinking_flag' };
  assert.equal(applyReasoningToResponses({}, toggle, 'on').thinking, true);
  assert.equal(applyReasoningToChat({}, toggle, 'off').thinking, false);
});

test('Codex compatibility probe distinguishes Responses function tools from custom/freeform tools', async () => {
  const requests = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    if (!body.tools) return new Response('ok', { status: 200 });
    if (body.tools[0]?.type === 'function') return new Response('ok', { status: 200 });
    return new Response(JSON.stringify({ error: { message: 'unsupported custom tool' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    });
  };
  const result = await probeCodexCompatibility({
    provider: { baseUrl: 'https://example.com/v1', authType: 'bearer' },
    apiKey: '',
    model: 'third-party-model',
    fetchImpl
  });
  assert.equal(result.protocol, 'responses');
  assert.equal(result.codex.functionTools, true);
  assert.equal(result.codex.mcpTools, true);
  assert.equal(result.codex.customTools, false);
  assert.equal(result.grade, 'responses-function');
  assert.equal(requests.some((body) => body.tools?.[0]?.type === 'custom'), true);
});
