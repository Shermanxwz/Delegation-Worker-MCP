import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EPERM'].includes(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function atomicWrite(file, data, { mode = 0o600 } = {}) {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', mode);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, file);
    await fs.chmod(file, mode).catch(() => {});
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return structuredClone(fallback);
    throw error;
  }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export async function withFileLock(target, operation, { timeoutMs = 5000, staleMs = 30000 } = {}) {
  const lock = `${target}.lock`;
  const started = Date.now();
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  let handle;
  while (!handle) {
    try {
      handle = await fs.open(lock, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = await fs.stat(lock);
        if (Date.now() - stat.mtimeMs > staleMs) {
          await fs.unlink(lock).catch(() => {});
          continue;
        }
      } catch (statError) {
        if (statError.code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for file lock: ${target}`);
      await sleep(25 + Math.floor(Math.random() * 25));
    }
  }
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => {});
    await fs.unlink(lock).catch(() => {});
  }
}
