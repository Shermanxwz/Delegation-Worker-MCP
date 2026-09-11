import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const IGNORE = new Set(['.git', 'node_modules', '.seal', 'coverage']);

async function walk(root, directory = root, out = []) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORE.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(root, full, out);
    else if (entry.isFile()) out.push(path.relative(root, full).replaceAll(path.sep, '/'));
  }
  return out;
}

export async function treeDigest(root) {
  const files = (await walk(root)).sort();
  const digest = crypto.createHash('sha256');
  for (const file of files) {
    const bytes = await fs.readFile(path.join(root, file));
    digest.update(file); digest.update('\0'); digest.update(bytes); digest.update('\0');
  }
  return { algorithm: 'sha256', digest: digest.digest('hex'), files: files.length };
}
