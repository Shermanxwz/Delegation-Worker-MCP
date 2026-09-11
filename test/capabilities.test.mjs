import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReasoningCapability, normalizeCodexModelCapability, publicModel, reasoningSelection } from '../src/capabilities.mjs';

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

test('Codex tool capability uses explicit metadata and never guesses from model names', () => {
  const explicit = normalizeCodexModelCapability({
    id: 'x',
    capabilities: {
      supports_function_calling: true,
      supports_custom_tools: true,
      supports_parallel_tool_calls: false,
      context_window: 131072,
      input_modalities: ['text', 'image']
    }
  });
  assert.equal(explicit.source, 'upstream_metadata');
  assert.equal(explicit.functionTools, true);
  assert.equal(explicit.customTools, true);
  assert.equal(explicit.mcpTools, true);
  assert.equal(explicit.parallelToolCalls, false);
  assert.equal(explicit.contextWindow, 131072);
  assert.deepEqual(explicit.inputModalities, ['text', 'image']);

  const unknown = normalizeCodexModelCapability({ id: 'MiniMax-super-coder' });
  assert.equal(unknown.source, 'unknown');
  assert.equal(unknown.functionTools, null);
  assert.equal(unknown.customTools, null);
  assert.deepEqual(unknown.inputModalities, []);
});

test('operator override can declare Codex tool capability with provenance', () => {
  const model = publicModel({ id: 'x' }, {
    override: {
      codex: {
        functionTools: true,
        customTools: false,
        contextWindow: 65536,
        inputModalities: ['text']
      }
    }
  });
  assert.equal(model.codex.source, 'operator_override');
  assert.equal(model.codex.functionTools, true);
  assert.equal(model.codex.customTools, false);
  assert.equal(model.codex.contextWindow, 65536);
});
