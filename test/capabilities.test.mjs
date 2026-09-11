import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReasoningCapability, reasoningSelection } from '../src/capabilities.mjs';

test('effort capability is read from explicit upstream metadata', () => {
  const c = normalizeReasoningCapability({ id: 'x', supported_reasoning_efforts: ['low', 'medium', 'high'], default_reasoning_effort: 'medium' });
  assert.equal(c.kind, 'effort');
  assert.equal(c.source, 'upstream_metadata');
  assert.deepEqual(c.options.map((x) => x.value), ['auto', 'low', 'medium', 'high']);
  assert.equal(c.default, 'medium');
  assert.equal(c.requestStyle, 'openai_reasoning');
});

test('thinking toggle is dynamic and model names are never guessed', () => {
  const toggle = normalizeReasoningCapability({ id: 'whatever', metadata: { supports_thinking: true } });
  assert.equal(toggle.kind, 'toggle');
  assert.deepEqual(toggle.options.map((x) => x.value), ['auto', 'on', 'off']);
  const unknown = normalizeReasoningCapability({ id: 'MiniMax-M2-super-reasoner' });
  assert.equal(unknown.kind, 'unknown');
  assert.deepEqual(unknown.options.map((x) => x.value), ['auto']);
});

test('operator override keeps provenance and validation', () => {
  const c = normalizeReasoningCapability({ id: 'x' }, { override: { kind: 'adaptive', options: ['off', 'adaptive'], default: 'adaptive', requestStyle: 'thinking_mode' } });
  assert.equal(c.source, 'operator_override');
  assert.equal(reasoningSelection(c, 'adaptive'), 'adaptive');
  assert.equal(reasoningSelection(c, 'high'), 'auto');
});
