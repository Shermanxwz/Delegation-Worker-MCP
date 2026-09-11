const MAX_OPTION = 128;

function text(value, max = 1024) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, max);
}

function arrayAt(obj, keys) {
  for (const key of keys) if (Array.isArray(obj?.[key])) return obj[key];
  return null;
}

function objectAt(obj, keys) {
  for (const key of keys) if (obj?.[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) return obj[key];
  return null;
}

function boolAt(obj, keys) {
  for (const key of keys) if (typeof obj?.[key] === 'boolean') return obj[key];
  return null;
}

function capabilityContainers(raw) {
  return [
    raw,
    raw?.metadata,
    raw?.capabilities,
    raw?.metadata?.capabilities,
    raw?.tools,
    raw?.metadata?.tools
  ].filter((value) => value && typeof value === 'object' && !Array.isArray(value));
}

function advertisedBool(containers, keys) {
  for (const container of containers) {
    for (const key of keys) {
      if (typeof container?.[key] === 'boolean') return { value: container[key], field: key };
    }
  }
  return { value: null, field: null };
}

function advertisedNumber(containers, keys) {
  for (const container of containers) {
    for (const key of keys) {
      const value = Number(container?.[key]);
      if (Number.isFinite(value) && value > 0) return { value, field: key };
    }
  }
  return { value: null, field: null };
}

function advertisedModalities(containers) {
  const keys = ['inputModalities', 'input_modalities', 'modalities'];
  for (const container of containers) {
    const values = arrayAt(container, keys);
    if (!values) continue;
    const normalized = [...new Set(values
      .map((value) => text(value, 64).toLowerCase())
      .filter((value) => ['text', 'image', 'audio'].includes(value)))];
    if (normalized.length) return { value: normalized, field: keys.find((key) => Array.isArray(container?.[key])) || null };
  }
  return { value: [], field: null };
}

function optionValue(item) {
  if (typeof item === 'string' || typeof item === 'number') return text(item, MAX_OPTION);
  if (!item || typeof item !== 'object') return '';
  return text(item.value ?? item.id ?? item.effort ?? item.reasoningEffort ?? item.reasoning_effort ?? item.name, MAX_OPTION);
}

function optionLabel(item, value) {
  if (!item || typeof item !== 'object') return value;
  return text(item.label ?? item.description ?? item.name, 256) || value;
}

export function normalizeOptions(values = []) {
  const seen = new Set();
  const output = [];
  for (const item of values) {
    const value = optionValue(item);
    if (!value || value === 'auto' || seen.has(value)) continue;
    seen.add(value);
    output.push({ value, label: optionLabel(item, value) });
  }
  return output;
}

function defaultFor(raw, options) {
  const value = optionValue(raw);
  return options.some((item) => item.value === value) ? value : 'auto';
}

function capability(kind, options, source, requestStyle, defaultValue = 'auto', evidence = null) {
  return {
    kind,
    advertised: kind !== 'unknown' && options.length > 0,
    source,
    requestStyle,
    options: [{ value: 'auto', label: 'Auto' }, ...options],
    default: defaultValue || 'auto',
    evidence
  };
}

function effortCapability(raw, source) {
  const containers = [raw, raw?.metadata, raw?.capabilities, raw?.metadata?.capabilities, raw?.reasoning, raw?.metadata?.reasoning].filter(Boolean);
  const keys = ['supportedReasoningEfforts', 'supported_reasoning_efforts', 'supportedReasoningLevels', 'supported_reasoning_levels', 'reasoningEfforts', 'reasoning_efforts', 'efforts', 'levels'];
  for (const container of containers) {
    const advertised = arrayAt(container, keys);
    if (!advertised) continue;
    const options = normalizeOptions(advertised);
    if (!options.length) continue;
    const defaultRaw = container.defaultReasoningEffort ?? container.default_reasoning_effort ?? container.defaultReasoningLevel ?? container.default_reasoning_level ?? container.defaultEffort ?? container.default;
    return capability('effort', options, source, 'openai_reasoning', defaultFor(defaultRaw, options), { field: keys.find((key) => Array.isArray(container[key])) });
  }
  return null;
}

function thinkingCapability(raw, source) {
  const containers = [raw, raw?.metadata, raw?.capabilities, raw?.metadata?.capabilities].filter(Boolean);
  for (const container of containers) {
    const thinking = objectAt(container, ['thinking', 'reasoningThinking', 'reasoning_thinking']);
    if (thinking) {
      const budget = thinking.budget ?? thinking.budgetTokens ?? thinking.budget_tokens ?? thinking.maxBudget ?? thinking.max_budget;
      if (budget !== undefined || thinking.minBudget !== undefined || thinking.min_budget !== undefined) {
        const min = Number(thinking.minBudget ?? thinking.min_budget ?? 1);
        const max = Number(thinking.maxBudget ?? thinking.max_budget ?? budget ?? 32768);
        const defaults = Number(thinking.defaultBudget ?? thinking.default_budget ?? budget);
        const values = [min, defaults, max].filter(Number.isFinite).filter((v, i, a) => v > 0 && a.indexOf(v) === i).sort((a, b) => a - b).map((value) => ({ value: String(value), label: `${value} tokens` }));
        if (values.length) return capability('budget', values, source, 'thinking_budget', Number.isFinite(defaults) ? String(defaults) : 'auto', { field: 'thinking' });
      }
      const modes = arrayAt(thinking, ['options', 'modes', 'supportedModes', 'supported_modes', 'levels']);
      if (modes?.length) {
        const options = normalizeOptions(modes);
        const lower = options.map((item) => item.value.toLowerCase());
        const kind = lower.some((v) => ['adaptive', 'dynamic'].includes(v)) ? 'adaptive' : (lower.some((v) => ['on', 'enabled', 'true'].includes(v)) && lower.some((v) => ['off', 'disabled', 'false'].includes(v)) ? 'toggle' : 'adaptive');
        return capability(kind, options, source, 'thinking_mode', defaultFor(thinking.defaultMode ?? thinking.default_mode ?? thinking.default, options), { field: 'thinking' });
      }
      const enabled = boolAt(thinking, ['supported', 'enabled', 'available']);
      if (enabled === true) return capability('toggle', [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }], source, 'thinking_flag', 'auto', { field: 'thinking' });
    }
    const supportsThinking = boolAt(container, ['supportsThinking', 'supports_thinking', 'thinkingSupported', 'thinking_supported']);
    if (supportsThinking === true) return capability('toggle', [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }], source, 'thinking_flag', 'auto', { field: 'supportsThinking' });
    const adaptive = boolAt(container, ['adaptiveThinking', 'adaptive_thinking', 'supportsAdaptiveThinking', 'supports_adaptive_thinking']);
    if (adaptive === true) return capability('adaptive', [{ value: 'adaptive', label: 'Adaptive' }, { value: 'off', label: 'Off' }], source, 'thinking_mode', 'auto', { field: 'adaptiveThinking' });
  }
  return null;
}

export function normalizeReasoningCapability(rawModel = {}, { override = null, source = 'upstream_metadata' } = {}) {
  if (override && typeof override === 'object') {
    const options = normalizeOptions(override.options || []);
    const kind = ['effort', 'toggle', 'adaptive', 'budget'].includes(override.kind) ? override.kind : 'unknown';
    if (kind !== 'unknown' && options.length) {
      const style = text(override.requestStyle, 64) || (kind === 'effort' ? 'openai_reasoning' : kind === 'budget' ? 'thinking_budget' : 'thinking_mode');
      return capability(kind, options, 'operator_override', style, defaultFor(override.default, options), { operator: true });
    }
  }
  return effortCapability(rawModel, source) || thinkingCapability(rawModel, source) || capability('unknown', [], 'unknown', 'none', 'auto', null);
}

export function normalizeCodexModelCapability(rawModel = {}, { override = null } = {}) {
  const containers = capabilityContainers(rawModel);
  const functionTools = advertisedBool(containers, [
    'supportsFunctionCalling', 'supports_function_calling',
    'supportsToolCalls', 'supports_tool_calls',
    'supportsTools', 'supports_tools'
  ]);
  const customTools = advertisedBool(containers, [
    'supportsCustomTools', 'supports_custom_tools',
    'supportsFreeformTools', 'supports_freeform_tools',
    'customTools', 'custom_tools',
    'freeformTools', 'freeform_tools'
  ]);
  const parallelToolCalls = advertisedBool(containers, ['supportsParallelToolCalls', 'supports_parallel_tool_calls']);
  const supportsSearchTool = advertisedBool(containers, ['supportsSearchTool', 'supports_search_tool']);
  const contextWindow = advertisedNumber(containers, ['contextWindow', 'context_window', 'maxContextWindow', 'max_context_window']);
  const inputModalities = advertisedModalities(containers);

  const fields = [
    functionTools.field, customTools.field, parallelToolCalls.field,
    supportsSearchTool.field, contextWindow.field, inputModalities.field
  ];
  const normalized = {
    source: fields.some(Boolean) ? 'upstream_metadata' : 'unknown',
    functionTools: functionTools.value,
    customTools: customTools.value,
    mcpTools: functionTools.value,
    parallelToolCalls: parallelToolCalls.value,
    supportsSearchTool: supportsSearchTool.value,
    contextWindow: contextWindow.value,
    inputModalities: inputModalities.value,
    evidence: {
      functionTools: functionTools.field,
      customTools: customTools.field,
      parallelToolCalls: parallelToolCalls.field,
      supportsSearchTool: supportsSearchTool.field,
      contextWindow: contextWindow.field,
      inputModalities: inputModalities.field
    }
  };

  if (override && typeof override === 'object') {
    for (const key of ['functionTools', 'customTools', 'mcpTools', 'parallelToolCalls', 'supportsSearchTool']) {
      if (typeof override[key] === 'boolean') normalized[key] = override[key];
    }
    const context = Number(override.contextWindow);
    if (Number.isFinite(context) && context > 0) normalized.contextWindow = context;
    if (Array.isArray(override.inputModalities)) {
      normalized.inputModalities = [...new Set(override.inputModalities
        .map((value) => text(value, 64).toLowerCase())
        .filter((value) => ['text', 'image', 'audio'].includes(value)))];
    }
    normalized.source = 'operator_override';
    normalized.evidence = { operator: true };
  }

  return normalized;
}

export function publicModel(raw = {}, { override = null } = {}) {
  const id = text(raw.id ?? raw.model ?? raw.name, 512);
  if (!id) return null;
  return {
    id,
    name: text(raw.display_name ?? raw.displayName ?? raw.name, 1024) || id,
    ownedBy: text(raw.owned_by ?? raw.ownedBy, 256) || null,
    reasoning: normalizeReasoningCapability(raw, { override }),
    codex: normalizeCodexModelCapability(raw, { override: override?.codex || null }),
    raw
  };
}

export function reasoningSelection(capability, selected = 'auto') {
  const value = text(selected, MAX_OPTION) || 'auto';
  const supported = new Set((capability?.options || []).map((item) => item.value));
  return supported.has(value) ? value : 'auto';
}