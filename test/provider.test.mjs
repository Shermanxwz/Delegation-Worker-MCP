import test from 'node:test';
import assert from 'node:assert/strict';
import { endpoints, applyReasoningToResponses, applyReasoningToChat } from '../src/provider.mjs';

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
