import fs from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from './paths.mjs';

let baseInstructionsPromise = null;

export function loadCodexBaseInstructions() {
  baseInstructionsPromise ||= fs.readFile(path.join(projectRoot, 'vendor', 'codex-model-prompt.md'), 'utf8');
  return baseInstructionsPromise;
}

function selectedBoolean(probed, advertised, key) {
  if (typeof probed?.[key] === 'boolean') return probed[key];
  if (typeof advertised?.[key] === 'boolean') return advertised[key];
  return null;
}

export function effectiveCodexCapability(model = {}) {
  const advertised = model.codex && typeof model.codex === 'object' ? model.codex : {};
  const probed = model.probe?.codex && typeof model.probe.codex === 'object' ? model.probe.codex : {};
  const probedContext = Number(probed.contextWindow);
  const advertisedContext = Number(advertised.contextWindow);
  const inputModalities = Array.isArray(probed.inputModalities) && probed.inputModalities.length
    ? probed.inputModalities
    : (Array.isArray(advertised.inputModalities) ? advertised.inputModalities : []);
  return {
    source: model.probe?.probedAt ? 'active_probe' : (advertised.source || 'unknown'),
    functionTools: selectedBoolean(probed, advertised, 'functionTools'),
    customTools: selectedBoolean(probed, advertised, 'customTools'),
    mcpTools: selectedBoolean(probed, advertised, 'mcpTools'),
    parallelToolCalls: selectedBoolean(probed, advertised, 'parallelToolCalls'),
    supportsSearchTool: selectedBoolean(probed, advertised, 'supportsSearchTool'),
    contextWindow: Number.isFinite(probedContext) && probedContext > 0
      ? probedContext
      : (Number.isFinite(advertisedContext) && advertisedContext > 0 ? advertisedContext : null),
    inputModalities: [...new Set(inputModalities.filter((value) => ['text', 'image', 'audio'].includes(value)))]
  };
}

export function codexParity(model = {}) {
  const capability = effectiveCodexCapability(model);
  const protocol = model.probe?.protocol || null;
  const responses = protocol === 'responses';
  const functionTools = capability.functionTools === true;
  const customTools = capability.customTools === true;
  return {
    grade: responses && functionTools && customTools
      ? 'full-candidate'
      : (responses && functionTools ? 'responses-function' : 'compatibility'),
    protocol,
    functionTools: capability.functionTools,
    customTools: capability.customTools,
    mcpTools: capability.mcpTools,
    applyPatch: customTools,
    shell: capability.functionTools !== false,
    capabilitySource: capability.source,
    probedAt: model.probe?.probedAt || null
  };
}

function effortMetadata(model, route) {
  const reasoning = model?.reasoning;
  if (reasoning?.kind !== 'effort') return { levels: [], defaultLevel: null };
  const levels = (reasoning.options || [])
    .filter((option) => option.value && option.value !== 'auto')
    .map((option) => ({ effort: option.value, description: option.label || option.value }));
  const values = new Set(levels.map((entry) => entry.effort));
  const selected = route?.reasoning && route.reasoning !== 'auto' ? route.reasoning : reasoning.default;
  return { levels, defaultLevel: values.has(selected) ? selected : null };
}

export function codexModelInfoForRoute({ route, model, baseInstructions }) {
  const capability = effectiveCodexCapability(model);
  const { levels, defaultLevel } = effortMetadata(model, route);
  const contextWindow = capability.contextWindow;
  return {
    slug: route.alias,
    display_name: `Worker · ${model?.name || model?.id || route.modelId}`,
    description: `Delegation Worker route for ${model?.id || route.modelId}`,
    default_reasoning_level: defaultLevel,
    supported_reasoning_levels: levels,
    shell_type: capability.functionTools === false ? 'disabled' : 'unified_exec',
    visibility: 'none',
    supported_in_api: true,
    priority: 99,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    availability_nux: null,
    upgrade: null,
    base_instructions: String(baseInstructions || ''),
    include_skills_usage_instructions: false,
    include_plugin_usage_instructions: false,
    include_apps_usage_instructions: false,
    supports_reasoning_summary_parameter: false,
    default_reasoning_summary: 'auto',
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: capability.customTools === true ? 'freeform' : null,
    web_search_tool_type: 'text',
    truncation_policy: { mode: 'bytes', limit: 10000 },
    supports_image_detail_original: false,
    context_window: contextWindow,
    max_context_window: contextWindow,
    auto_compact_token_limit: null,
    comp_hash: null,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: capability.inputModalities.length ? capability.inputModalities : ['text'],
    supports_search_tool: capability.supportsSearchTool === true,
    supports_experimental_context: false,
    use_responses_lite: false,
    node_repl_auto_review_required: false,
    node_repl_disabled: false,
    auto_review_model_override: null,
    model_specialty: null,
    tool_mode: null,
    multi_agent_version: null,
    multi_agent_reasoning_effort: null
  };
}
