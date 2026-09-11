import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/task-store.mjs';

function task(id, status, createdAt) {
  return { taskId: id, status, createdAt, updatedAt: createdAt, completedAt: status === 'running' ? null : createdAt };
}

test('TaskStore retention prunes old/excess terminal history but preserves active tasks', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dwmcp-tasks-'));
  const env = {
    ...process.env,
    DWMCP_DATA_DIR: dir,
    DWMCP_TASK_MAX_COUNT: '2',
    DWMCP_TASK_MAX_AGE_MS: String(24 * 60 * 60 * 1000)
  };
  const store = new TaskStore({ env });
  const now = Date.now();
  await store.write(task('wrk_active1', 'running', new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString()));
  await store.write(task('wrk_old001', 'completed', new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString()));
  await store.write(task('wrk_new001', 'completed', new Date(now - 3000).toISOString()));
  await store.write(task('wrk_new002', 'failed', new Date(now - 2000).toISOString()));
  await store.write(task('wrk_new003', 'cancelled', new Date(now - 1000).toISOString()));

  await store.prune({ now });
  const all = await store.list(20);
  const ids = all.map((entry) => entry.taskId);
  assert.ok(ids.includes('wrk_active1'));
  assert.equal(ids.includes('wrk_old001'), false);
  const terminals = all.filter((entry) => entry.status !== 'running');
  assert.equal(terminals.length, 2);
  assert.deepEqual(terminals.map((entry) => entry.taskId).sort(), ['wrk_new002', 'wrk_new003']);
});
