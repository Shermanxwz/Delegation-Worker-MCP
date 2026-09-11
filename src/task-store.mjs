import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from './atomic.mjs';
import { taskDir, taskPath } from './paths.mjs';

const TERMINAL = new Set(['completed', 'failed', 'timed_out', 'cancelled', 'verification_failed', 'needs_followup']);
const DEFAULT_MAX_COUNT = 500;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function taskTime(task) {
  return Date.parse(task?.completedAt || task?.updatedAt || task?.createdAt || '') || 0;
}

export class TaskStore {
  constructor({ env = process.env } = {}) {
    this.env = env;
    this.maxCount = positiveInt(env.DWMCP_TASK_MAX_COUNT, DEFAULT_MAX_COUNT);
    this.maxAgeMs = positiveInt(env.DWMCP_TASK_MAX_AGE_MS, DEFAULT_MAX_AGE_MS);
  }

  async write(task) {
    await fs.mkdir(taskDir(this.env), { recursive: true, mode: 0o700 });
    await atomicWrite(taskPath(task.taskId, this.env), `${JSON.stringify(task, null, 2)}\n`, { mode: 0o600 });
    if (TERMINAL.has(task?.status)) await this.prune().catch(() => {});
    return task;
  }

  async read(taskId) {
    try { return JSON.parse(await fs.readFile(taskPath(taskId, this.env), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  async list(limit = 20) {
    try {
      const names = (await fs.readdir(taskDir(this.env))).filter((name) => name.endsWith('.json'));
      const tasks = [];
      for (const name of names) {
        try { tasks.push(JSON.parse(await fs.readFile(path.join(taskDir(this.env), name), 'utf8'))); } catch {}
      }
      return tasks
        .sort((a, b) => taskTime(b) - taskTime(a))
        .slice(0, Math.max(1, Math.min(1000, Number(limit) || 20)));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async prune({ now = Date.now() } = {}) {
    const tasks = await this.list(100000);
    const terminal = tasks.filter((task) => TERMINAL.has(task?.status)).sort((a, b) => taskTime(b) - taskTime(a));
    const remove = new Set();
    for (const task of terminal) {
      const at = taskTime(task);
      if (at && now - at > this.maxAgeMs) remove.add(task.taskId);
    }
    for (const task of terminal.slice(this.maxCount)) remove.add(task.taskId);
    let removed = 0;
    for (const taskId of remove) {
      try {
        await fs.rm(taskPath(taskId, this.env), { force: true });
        removed += 1;
      } catch {}
    }
    return { removed, maxCount: this.maxCount, maxAgeMs: this.maxAgeMs };
  }
}
