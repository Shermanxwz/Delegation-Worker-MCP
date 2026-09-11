import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexAppServerClient, codexRuntimeArgs } from '../src/app-server.mjs';

async function fakeCodex(mode) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dwmcp-app-server-'));
  const file = path.join(dir, 'codex');
  const source = `#!/usr/bin/env node
const readline=require('node:readline');
const mode=process.env.FAKE_MODE;
let reads=0;
const out=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');
const rl=readline.createInterface({input:process.stdin});
rl.on('line',(line)=>{
  const message=JSON.parse(line);
  if(message.method==='initialize') return out({jsonrpc:'2.0',id:message.id,result:{platformFamily:'unix'}});
  if(message.method==='initialized') return;
  if(message.method==='thread/start') return out({jsonrpc:'2.0',id:message.id,result:{thread:{id:'thread-1',sessionId:'session-1',status:{type:'idle'}}}});
  if(message.method==='turn/start'){
    out({jsonrpc:'2.0',id:message.id,result:{turn:{id:'turn-1',status:'inProgress'}}});
    if(mode==='exit') setTimeout(()=>process.exit(17),30);
    return;
  }
  if(message.method==='thread/read'){
    reads+=1;
    const active=mode==='reconcile'&&reads<2;
    return out({jsonrpc:'2.0',id:message.id,result:{thread:{id:'thread-1',status:{type:active?'active':'idle'}}}});
  }
  if(message.method==='thread/unsubscribe') return out({jsonrpc:'2.0',id:message.id,result:{}});
  if(message.method==='turn/interrupt'){
    if(mode==='interrupt-error') return out({jsonrpc:'2.0',id:message.id,error:{code:-32001,message:'interrupt rejected'}});
    return out({jsonrpc:'2.0',id:message.id,result:{}});
  }
  if(message.id!==undefined) out({jsonrpc:'2.0',id:message.id,result:{}});
});
`;
  await fs.writeFile(file, source, { mode: 0o755 });
  return { dir, file, env: { ...process.env, FAKE_MODE: mode, CODEX_BIN: file } };
}

test('Codex runtime provider is process-scoped through official --config overrides', () => {
  const args = codexRuntimeArgs({
    DWMCP_GATEWAY_BASE_URL: 'http://127.0.0.1:8791/v1',
    DWMCP_GATEWAY_TOKEN: 'token-value'
  });
  assert.equal(args[0], '--config');
  assert.match(args[1], /model_providers\.delegation_worker_gateway/);
  assert.match(args[1], /env_key = "DWMCP_GATEWAY_TOKEN"/);
  assert.doesNotMatch(args[1], /command\s*=/);
  assert.deepEqual(args.slice(-3), ['app-server', '--listen', 'stdio://']);
});

test('runThread reconciles a lost terminal notification through authoritative thread/read', async (t) => {
  const fake = await fakeCodex('reconcile');
  t.after(() => fs.rm(fake.dir, { recursive: true, force: true }));
  const client = new CodexAppServerClient({ env: fake.env, binary: fake.file, reconcileIntervalMs: 25 });
  await client.start();
  const result = await client.runThread({
    model: 'dw_route',
    modelProvider: 'delegation_worker_gateway',
    prompt: 'work',
    timeoutMs: 3000
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.reconciled, true);
  assert.equal(result.threadId, 'thread-1');
  assert.equal(result.sessionId, 'session-1');
  await client.close();
});

test('app-server process exit rejects an active turn instead of hanging until hard timeout', async (t) => {
  const fake = await fakeCodex('exit');
  t.after(() => fs.rm(fake.dir, { recursive: true, force: true }));
  const client = new CodexAppServerClient({ env: fake.env, binary: fake.file, reconcileIntervalMs: 1000 });
  await client.start();
  await assert.rejects(
    () => client.runThread({
      model: 'dw_route',
      modelProvider: 'delegation_worker_gateway',
      prompt: 'work',
      timeoutMs: 10000
    }),
    (error) => error?.code === 'CODEX_APP_SERVER_EXITED'
  );
});

test('interrupt confirmation propagates the official RPC failure', async (t) => {
  const fake = await fakeCodex('interrupt-error');
  t.after(() => fs.rm(fake.dir, { recursive: true, force: true }));
  const client = new CodexAppServerClient({ env: fake.env, binary: fake.file });
  await client.start();
  await assert.rejects(
    () => client.interruptAndConfirm('thread-1', 'turn-1', { timeoutMs: 1000, pollMs: 10 }),
    /interrupt rejected/
  );
  await client.close();
});

test('interrupt confirmation requires an authoritative idle thread state', async (t) => {
  const fake = await fakeCodex('interrupt-ok');
  t.after(() => fs.rm(fake.dir, { recursive: true, force: true }));
  const client = new CodexAppServerClient({ env: fake.env, binary: fake.file });
  await client.start();
  const result = await client.interruptAndConfirm('thread-1', 'turn-1', { timeoutMs: 1000, pollMs: 10 });
  assert.equal(result.confirmed, true);
  assert.equal(result.threadId, 'thread-1');
  await client.close();
});
