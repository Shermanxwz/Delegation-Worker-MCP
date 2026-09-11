import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(here, '..');

function homeDir(env = process.env) {
  const home = env.HOME || os.homedir();
  if (!home || !path.isAbsolute(home)) throw new Error('HOME must be an absolute path');
  return path.resolve(home);
}

export function dataDir(env = process.env) {
  const value = env.DWMCP_DATA_DIR ? path.resolve(env.DWMCP_DATA_DIR) : path.join(homeDir(env), '.local', 'share', 'delegation-worker-mcp');
  if (!path.isAbsolute(value)) throw new Error('DWMCP_DATA_DIR must resolve to an absolute path');
  return value;
}

export function codexHome(env = process.env) {
  return path.resolve(env.CODEX_HOME || path.join(homeDir(env), '.codex'));
}

export function statePath(env = process.env) { return path.join(dataDir(env), 'state.json'); }
export function vaultKeyPath(env = process.env) { return path.join(dataDir(env), 'master.key'); }
export function gatewayTokenPath(env = process.env) { return path.join(dataDir(env), 'gateway.token'); }
export function taskDir(env = process.env) { return path.join(dataDir(env), 'tasks'); }
export function taskPath(taskId, env = process.env) {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(String(taskId || ''))) throw new Error('invalid task id');
  return path.join(taskDir(env), `${taskId}.json`);
}
