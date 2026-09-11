import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const MAX_BUFFER = 4 * 1024 * 1024;
const TERMINAL_TURN_METHODS = new Set(['turn/completed', 'turn/failed', 'turn/error', 'turn/interrupted', 'turn/cancelled', 'turn/canceled', 'turn/stopped']);
const RUNTIME_PROVIDER_ID = 'delegation_worker_gateway';
const RUNTIME_TOKEN_ENV = 'DWMCP_GATEWAY_TOKEN';

function statusKey(value) {
  return String(value?.type || value || '').toLowerCase().replace(/[\s_-]/g, '');
}

function runtimeProviderOverride(env = process.env) {
  const baseUrl = String(env.DWMCP_GATEWAY_BASE_URL || '').trim();
  const token = String(env[RUNTIME_TOKEN_ENV] || '').trim();
  if (!baseUrl || !token) return null;
  return `model_providers.${RUNTIME_PROVIDER_ID}={ name = "Delegation Worker Gateway", base_url = ${JSON.stringify(baseUrl)}, env_key = "${RUNTIME_TOKEN_ENV}", wire_api = "responses", requires_openai_auth = false, supports_websockets = false }`;
}

export function codexRuntimeArgs(env = process.env) {
  const args = [];
  const provider = runtimeProviderOverride(env);
  if (provider) args.push('--config', provider);
  args.push('app-server', '--listen', 'stdio://');
  return args;
}

export function resolveCodexBinary(env = process.env) {
  const home = env.HOME || os.homedir();
  const executable = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const candidates = [
    env.CODEX_CLI_PATH, env.CODEX_BIN, '/usr/lib/chatgpt/resources/codex',
    path.join(home, '.local', 'bin', executable), path.join(home, '.codex', 'bin', executable)
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
  }
  const finder = process.platform === 'win32' ? 'where.exe' : 'which';
  const probe = spawnSync(finder, ['codex'], { encoding: 'utf8', env, windowsHide: true });
  const found = probe.status === 0 ? String(probe.stdout || '').split(/\r?\n/).map((value) => value.trim()).find(Boolean) : '';
  return found || 'codex';
}

export class CodexAppServerClient {
  constructor({
    env = process.env,
    binary = resolveCodexBinary(env),
    timeoutMs = 20000,
    onServerRequest = null,
    reconcileIntervalMs = 1500
  } = {}) {
    this.env = env;
    this.binary = binary;
    this.timeoutMs = timeoutMs;
    this.onServerRequest = onServerRequest;
    this.reconcileIntervalMs = Math.max(100, Number(reconcileIntervalMs) || 1500);
    this.process = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.serverRequests = new Map();
    this.activeRuns = new Set();
    this.buffer = '';
    this.stderr = '';
  }

  setServerRequestHandler(handler) { this.onServerRequest = typeof handler === 'function' ? handler : null; }

  async start() {
    if (this.process) return this;
    const child = spawn(this.binary, codexRuntimeArgs(this.env), {
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.process = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#feed(chunk));
    child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-12000); });
    child.on('error', (error) => this.#fail(error));
    child.on('exit', (code, signal) => {
      if (this.process !== child) return;
      this.process = null;
      this.#fail(Object.assign(
        new Error(`codex app-server exited (${code ?? 'null'}${signal ? `/${signal}` : ''}): ${this.stderr.trim().slice(-3000)}`),
        { code: 'CODEX_APP_SERVER_EXITED' }
      ));
    });
    await this.request('initialize', {
      clientInfo: { name: 'delegation_worker_mcp', title: 'Delegation Worker MCP', version: '0.3.0' },
      capabilities: { experimentalApi: true }
    });
    this.notify('initialized', {});
    return this;
  }

  request(method, params = {}, timeoutMs = this.timeoutMs) {
    if (!this.process?.stdin?.writable) return Promise.reject(Object.assign(new Error('codex app-server is not running'), { code: 'CODEX_APP_SERVER_NOT_RUNNING' }));
    const id = this.nextId++;
    const message = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`codex app-server request timed out: ${method}`), { code: 'CODEX_RPC_TIMEOUT' }));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      this.process.stdin.write(`${message}\n`);
    });
  }

  notify(method, params = {}) {
    if (this.process?.stdin?.writable) this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  pendingServerRequests() {
    return [...this.serverRequests.values()].map((item) => structuredClone({
      id: item.id, method: item.method, params: item.params, receivedAt: item.receivedAt
    }));
  }

  respondServerRequest(id, result = {}) {
    const key = String(id);
    const request = this.serverRequests.get(key);
    if (!request) throw new Error('Codex server request is not pending');
    if (!this.process?.stdin?.writable) throw new Error('codex app-server is not running');
    this.serverRequests.delete(key);
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.rawId, result })}\n`);
    return { responded: true, requestId: key, method: request.method };
  }

  rejectServerRequest(id, message = 'request rejected by supervisor', code = -32001) {
    const key = String(id);
    const request = this.serverRequests.get(key);
    if (!request) throw new Error('Codex server request is not pending');
    if (!this.process?.stdin?.writable) throw new Error('codex app-server is not running');
    this.serverRequests.delete(key);
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.rawId, error: { code, message: String(message).slice(0, 1000) } })}\n`);
    return { rejected: true, requestId: key, method: request.method };
  }

  rejectAllServerRequests(message = 'worker ended before request was answered') {
    for (const key of [...this.serverRequests.keys()]) {
      try { this.rejectServerRequest(key, message); } catch { this.serverRequests.delete(key); }
    }
  }

  async readThread(threadId) {
    return this.request('thread/read', { threadId: String(threadId), includeTurns: false }, 15000);
  }

  async threadStatus(threadId) {
    const result = await this.readThread(threadId);
    const status = result?.thread?.status ?? result?.status ?? null;
    return { raw: status, key: statusKey(status), result };
  }

  async unsubscribe(threadId) {
    if (!threadId) return null;
    try { return await this.request('thread/unsubscribe', { threadId: String(threadId) }, 10000); }
    catch (error) {
      if (error?.code === -32601 || /method not found|unsupported/i.test(String(error?.message || ''))) return null;
      throw error;
    }
  }

  async interrupt(threadId, turnId) {
    return this.request('turn/interrupt', { threadId, turnId }, 30000);
  }

  async interruptAndConfirm(threadId, turnId, { timeoutMs = 30000, pollMs = 250 } = {}) {
    await this.interrupt(threadId, turnId);
    const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 30000);
    let last = null;
    while (Date.now() < deadline) {
      last = await this.threadStatus(threadId);
      if (['idle', 'notloaded'].includes(last.key)) {
        return { confirmed: true, threadId, turnId, threadStatus: last.raw };
      }
      if (last.key.includes('error')) {
        throw Object.assign(new Error(`Codex thread entered error state while confirming interrupt: ${last.key}`), {
          code: 'CODEX_INTERRUPT_RECONCILE_FAILED',
          threadId,
          turnId,
          threadStatus: last.raw
        });
      }
      await new Promise((resolve) => setTimeout(resolve, Math.max(50, Number(pollMs) || 250)));
    }
    throw Object.assign(new Error('Codex turn/interrupt was accepted but an authoritative idle state was not observed'), {
      code: 'CODEX_INTERRUPT_UNCONFIRMED',
      threadId,
      turnId,
      threadStatus: last?.raw || null
    });
  }

  async runThread({
    model, modelProvider, prompt, cwd = process.cwd(), sandbox = 'workspace-write',
    developerInstructions = '', config = null, outputSchema = null,
    timeoutMs = 60 * 60 * 1000, onProgress = null
  }) {
    if (!model || !modelProvider || !String(prompt || '').trim()) throw new Error('model, modelProvider and prompt are required');
    const started = await this.request('thread/start', {
      model, modelProvider, cwd, sandbox, approvalPolicy: 'never', ephemeral: true,
      serviceName: 'delegation-worker-mcp',
      ...(config && typeof config === 'object' ? { config } : {}),
      ...(developerInstructions ? { developerInstructions } : {})
    }, 30000);
    const threadId = started?.thread?.id;
    const sessionId = started?.thread?.sessionId || started?.thread?.session_id || null;
    if (!threadId) throw new Error('thread/start did not return a thread id');

    let turnId = '';
    let authoritativeIdleReads = 0;
    const emit = (message) => { try { onProgress?.(message); } catch {} };
    const run = { reject: null, cleanup: () => {} };
    this.activeRuns.add(run);

    const done = new Promise((resolve, reject) => {
      run.reject = reject;
      let settled = false;
      const unsubscribe = this.subscribe((message) => {
        if (message?.params?.threadId !== threadId && message?.params?.thread?.id !== threadId) return;
        emit(message);
        const candidateTurn = message?.params?.turn?.id || message?.params?.turnId;
        if (candidateTurn && !turnId) turnId = String(candidateTurn);
        if (TERMINAL_TURN_METHODS.has(message?.method)) {
          cleanup();
          resolve(message);
        }
      });
      const timer = setTimeout(() => {
        cleanup();
        reject(Object.assign(new Error(`worker turn exceeded hard limit ${timeoutMs}ms`), {
          code: 'WORKER_HARD_TIMEOUT', threadId, turnId
        }));
      }, timeoutMs);
      timer.unref?.();
      const reconcileTimer = setInterval(() => {
        if (!turnId || settled || !this.process) return;
        void this.threadStatus(threadId).then((state) => {
          if (settled) return;
          if (state.key === 'idle') authoritativeIdleReads += 1;
          else authoritativeIdleReads = 0;
          if (authoritativeIdleReads >= 2) {
            cleanup();
            const synthetic = {
              method: 'turn/reconciled',
              params: {
                threadId,
                turn: { id: turnId, status: 'completed', items: [] },
                authoritativeThreadStatus: state.raw
              }
            };
            emit({ method: 'delegation/authoritativeReconciliation', params: synthetic.params });
            resolve(synthetic);
          } else if (state.key.includes('error')) {
            cleanup();
            reject(Object.assign(new Error(`Codex thread entered authoritative error state: ${state.key}`), {
              code: 'CODEX_THREAD_ERROR',
              threadId,
              turnId,
              threadStatus: state.raw
            }));
          }
        }).catch(() => {});
      }, this.reconcileIntervalMs);
      reconcileTimer.unref?.();
      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(reconcileTimer);
        unsubscribe();
        this.activeRuns.delete(run);
      };
      run.cleanup = cleanup;
    });

    emit({ method: 'thread/started', params: { threadId, sessionId, model, modelProvider } });
    let turn;
    try {
      turn = await this.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: String(prompt), text_elements: [] }],
        ...(outputSchema && typeof outputSchema === 'object' ? { outputSchema } : {})
      }, 30000);
    } catch (error) {
      run.cleanup();
      await this.unsubscribe(threadId).catch(() => {});
      throw error;
    }
    turnId = String(turn?.turn?.id || turn?.id || turnId || '');
    emit({ method: 'turn/started', params: { threadId, turn: turn?.turn || { id: turnId } } });

    try {
      const terminal = await done;
      const detail = terminal?.params?.turn || terminal?.params || {};
      const items = Array.isArray(detail.items) ? detail.items : [];
      const messages = items.filter((item) => item?.type === 'agentMessage' && typeof item.text === 'string').map((item) => item.text);
      return {
        threadId,
        sessionId,
        turnId,
        status: detail.status?.type || detail.status || (terminal.method === 'turn/completed' ? 'completed' : terminal.method.replace('turn/', '')),
        reconciled: terminal.method === 'turn/reconciled',
        output: messages.at(-1) || '',
        messages,
        turn: detail
      };
    } catch (error) {
      run.cleanup();
      if (error.code === 'WORKER_HARD_TIMEOUT' && threadId && turnId) {
        await this.interruptAndConfirm(threadId, turnId, { timeoutMs: 10000 }).catch(() => {});
      }
      throw error;
    } finally {
      await this.unsubscribe(threadId).catch(() => {});
    }
  }

  async steer(threadId, turnId, text) {
    return this.request('turn/steer', {
      threadId, expectedTurnId: turnId,
      input: [{ type: 'text', text: String(text), text_elements: [] }],
      clientUserMessageId: `dwmcp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    }, 30000);
  }

  async close() {
    this.rejectAllServerRequests('worker client is closing');
    const closeError = Object.assign(new Error('codex app-server client is closing'), { code: 'CODEX_APP_SERVER_CLOSED' });
    for (const run of [...this.activeRuns]) {
      try { run.reject?.(closeError); } catch {}
      run.cleanup?.();
    }
    const child = this.process;
    this.process = null;
    if (!child) return;
    try { child.stdin.end(); } catch {}
    await new Promise((resolve) => {
      const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} resolve(); }, 800);
      timer.unref?.();
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }

  #feed(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_BUFFER && !this.buffer.includes('\n')) {
      this.#fail(new Error('codex app-server output exceeded safe line buffer'));
      return;
    }
    while (true) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) break;
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id !== undefined && !message.method) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(Object.assign(new Error(`Codex ${pending.method}: ${message.error.message || 'RPC error'}`), {
            rpcError: message.error, code: message.error.code
          }));
        } else pending.resolve(message.result);
      } else if (message.id !== undefined && message.method) {
        this.#captureServerRequest(message);
      } else if (message.method) {
        for (const listener of this.listeners) {
          try { listener(message); } catch {}
        }
      }
    }
  }

  #captureServerRequest(message) {
    const key = String(message.id);
    const entry = {
      id: key,
      rawId: message.id,
      method: String(message.method || ''),
      params: message.params && typeof message.params === 'object' ? structuredClone(message.params) : {},
      receivedAt: new Date().toISOString()
    };
    this.serverRequests.set(key, entry);
    for (const listener of this.listeners) {
      try { listener({ method: 'delegation/serverRequest', params: structuredClone(entry) }); } catch {}
    }
    if (this.onServerRequest) {
      try { Promise.resolve(this.onServerRequest(structuredClone(entry))).catch(() => {}); } catch {}
    }
  }

  #fail(error) {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const run of [...this.activeRuns]) {
      try { run.reject?.(error); } catch {}
      run.cleanup?.();
    }
    this.rejectAllServerRequests(error?.message || 'codex app-server failed');
  }
}
