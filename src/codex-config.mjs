import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, withFileLock } from './atomic.mjs';
import { codexHome, gatewayTokenPath } from './paths.mjs';

export const CODEX_PROVIDER_ID = 'delegation_worker_gateway';
const START = '# --- delegation-worker-mcp managed provider ---';
const END = '# --- end delegation-worker-mcp managed provider ---';

function quote(value) { return JSON.stringify(String(value)); }
function section(line) { return line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/)?.[1]?.trim() || null; }

export function inspectTopLevelSelectors(text) {
  let current = null; const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const s = section(line); if (s) { current = s; continue; }
    if (current) continue;
    const match = line.match(/^\s*(model_provider|model)\s*=\s*(.+?)\s*(?:#.*)?$/);
    if (match) out[match[1]] = match[2].trim();
  }
  return out;
}

function sameSelectors(a, b) { return ['model_provider', 'model'].every((key) => (a[key] || null) === (b[key] || null)); }

function removeManaged(text) {
  const lines = String(text || '').split(/\r?\n/); const out = []; let skipping = false;
  for (const line of lines) {
    if (line.trim() === START) { skipping = true; continue; }
    if (line.trim() === END) { skipping = false; continue; }
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function block(baseUrl, tokenFile) {
  return `${START}\n[model_providers.${CODEX_PROVIDER_ID}]\nname = "Delegation Worker Gateway"\nbase_url = ${quote(baseUrl)}\nwire_api = "responses"\n\n[model_providers.${CODEX_PROVIDER_ID}.auth]\ncommand = "cat"\nargs = [${quote(tokenFile)}]\n${END}`;
}

export class CodexConfigManager {
  constructor({ env = process.env, gatewayBaseUrl = null } = {}) {
    this.env = env; this.home = codexHome(env); this.file = path.join(this.home, 'config.toml');
    const port = Number(env.DWMCP_GATEWAY_PORT || 8791);
    this.gatewayBaseUrl = gatewayBaseUrl || `http://127.0.0.1:${port}/v1`;
  }
  async read() { try { return await fs.readFile(this.file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; } }
  async status() { const text = await this.read(); return { installed: text.includes(`[model_providers.${CODEX_PROVIDER_ID}]`) && text.includes(`base_url = ${quote(this.gatewayBaseUrl)}`), providerId: CODEX_PROVIDER_ID, gatewayBaseUrl: this.gatewayBaseUrl, selectors: inspectTopLevelSelectors(text) }; }
  async install() {
    await fs.mkdir(this.home, { recursive: true, mode: 0o700 });
    return withFileLock(this.file, async () => {
      const before = await this.read(); const selectors = inspectTopLevelSelectors(before);
      const cleaned = removeManaged(before); const managed = block(this.gatewayBaseUrl, gatewayTokenPath(this.env));
      const next = `${cleaned}${cleaned ? '\n\n' : ''}${managed}\n`;
      if (!sameSelectors(selectors, inspectTopLevelSelectors(next))) throw new Error('refusing to modify official top-level Codex model/provider selectors');
      await atomicWrite(this.file, next, { mode: 0o600 });
      return this.status();
    });
  }
  async uninstall() {
    return withFileLock(this.file, async () => {
      const before = await this.read(); const selectors = inspectTopLevelSelectors(before); const next = removeManaged(before);
      if (!sameSelectors(selectors, inspectTopLevelSelectors(next))) throw new Error('refusing to modify official top-level Codex model/provider selectors');
      await atomicWrite(this.file, next ? `${next}\n` : '', { mode: 0o600 });
      return { removed: true, ...(await this.status()) };
    });
  }
}
