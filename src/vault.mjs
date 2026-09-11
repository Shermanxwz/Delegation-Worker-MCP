import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { atomicWrite } from './atomic.mjs';
import { vaultKeyPath } from './paths.mjs';

const PREFIX = 'v1';

function b64(value) { return Buffer.from(value).toString('base64url'); }
function unb64(value) { return Buffer.from(String(value), 'base64url'); }

export class SecretVault {
  constructor({ env = process.env } = {}) { this.env = env; this.keyFile = vaultKeyPath(env); }

  async key() {
    try {
      const key = await fs.readFile(this.keyFile);
      if (key.length !== 32) throw new Error('vault master key has invalid length');
      return key;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const key = crypto.randomBytes(32);
      await atomicWrite(this.keyFile, key, { mode: 0o600 });
      return key;
    }
  }

  async encrypt(value) {
    const text = String(value ?? '');
    if (!text) return '';
    const key = await this.key();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [PREFIX, b64(iv), b64(tag), b64(encrypted)].join('.');
  }

  async decrypt(payload) {
    if (!payload) return '';
    const parts = String(payload).split('.');
    if (parts.length !== 4 || parts[0] !== PREFIX) throw new Error('unsupported vault payload');
    const key = await this.key();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, unb64(parts[1]));
    decipher.setAuthTag(unb64(parts[2]));
    return Buffer.concat([decipher.update(unb64(parts[3])), decipher.final()]).toString('utf8');
  }
}
