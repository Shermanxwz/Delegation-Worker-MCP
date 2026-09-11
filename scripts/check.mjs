import fs from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from '../src/paths.mjs';

const modules = ['atomic.mjs','paths.mjs','vault.mjs','capabilities.mjs','provider.mjs','translate.mjs','store.mjs','codex-config.mjs','app-server.mjs','task-store.mjs','worker-manager.mjs','gateway.mjs','runtime.mjs'];
for (const name of modules) await import(new URL(`../src/${name}`, import.meta.url));
const html = await fs.readFile(path.join(projectRoot, 'app', 'control.html'), 'utf8');
for (const needle of ['ui/initialize','session_mode_set','worker_profile_set','provider_save','WORKER','NATIVE']) if (!html.includes(needle)) throw new Error(`MCP App control surface is incomplete: ${needle}`);
if (Buffer.byteLength(html, 'utf8') > 512 * 1024) throw new Error('MCP App is unexpectedly large');
const mcp = await fs.readFile(path.join(projectRoot, 'mcp', 'server.mjs'), 'utf8');
for (const needle of ['contextFrom','threadId','worker_extend','worker_respond','session_mode_get','session_mode_set']) if (!mcp.includes(needle)) throw new Error(`MCP supervision contract missing: ${needle}`);
const manager = await fs.readFile(path.join(projectRoot, 'src', 'worker-manager.mjs'), 'utf8');
for (const needle of ['autoExtensionCount','pendingInteraction','client.steer','progressEvidence','leaseDeadlineAt','hardDeadlineAt']) if (!manager.includes(needle)) throw new Error(`Worker supervision contract missing: ${needle}`);
const sealFiles = ['tests/upstream-lock.json','scripts/verify-upstream-contracts.mjs','scripts/source-seal.mjs','scripts/target-seal.mjs','scripts/release-seal.mjs'];
for (const rel of sealFiles) await fs.access(path.join(projectRoot, rel));
console.log(`check ok: ${modules.length} modules, app=${Buffer.byteLength(html, 'utf8')} bytes, supervision=bounded, seal=source+target+release`);
