import fs from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from '../src/paths.mjs';

const modules = ['atomic.mjs','paths.mjs','vault.mjs','capabilities.mjs','provider.mjs','translate.mjs','store.mjs','codex-config.mjs','app-server.mjs','task-store.mjs','worker-manager.mjs','gateway.mjs','runtime.mjs'];
for (const name of modules) await import(new URL(`../src/${name}`, import.meta.url));
const html = await fs.readFile(path.join(projectRoot, 'app', 'control.html'), 'utf8');
if (!html.includes('ui/initialize') || !html.includes('worker_profile_set') || !html.includes('provider_save')) throw new Error('MCP App control surface is incomplete');
if (Buffer.byteLength(html, 'utf8') > 512 * 1024) throw new Error('MCP App is unexpectedly large');
console.log(`check ok: ${modules.length} modules, app=${Buffer.byteLength(html, 'utf8')} bytes`);
