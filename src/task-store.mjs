import fs from 'node:fs/promises';
import { atomicWrite } from './atomic.mjs';
import { taskDir, taskPath } from './paths.mjs';

export class TaskStore {
  constructor({ env = process.env } = {}) { this.env = env; }
  async write(task) { await fs.mkdir(taskDir(this.env), { recursive: true, mode: 0o700 }); await atomicWrite(taskPath(task.taskId, this.env), `${JSON.stringify(task, null, 2)}\n`, { mode: 0o600 }); return task; }
  async read(taskId) { try { return JSON.parse(await fs.readFile(taskPath(taskId, this.env), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
  async list(limit = 20) { try { const names = (await fs.readdir(taskDir(this.env))).filter((name) => name.endsWith('.json')).slice(-Math.max(1, Math.min(100, limit))); const tasks = []; for (const name of names) { try { tasks.push(JSON.parse(await fs.readFile(`${taskDir(this.env)}/${name}`, 'utf8'))); } catch {} } return tasks.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } }
}
