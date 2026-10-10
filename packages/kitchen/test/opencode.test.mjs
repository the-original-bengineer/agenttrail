import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, chmod, writeFile, readFile, realpath, symlink, link, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventMapper, createOpenCodeObserver, readRegistration } from '../src/opencode/core.mjs';
import opencodePlugin, { createOpenCodePlugin } from '../src/opencode/plugin.mjs';
import { startOffice } from '../src/server.mjs';
import { IdentityBook, providerName } from '../public/src/activity.js';

async function fixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'agenttrail-opencode-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const stateDir = join(home, '.local/state/code-harness/agenttrail');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(join(home, '.local'), 0o755);
  const file = join(stateDir, 'server.json');
  await writeFile(file, JSON.stringify({ port: 43210, pid: 123, hookToken: 'a'.repeat(48) }), { mode: 0o600 });
  const directory = join(home, 'repo');
  await mkdir(directory);
  return { home, directory, stateDir, file };
}
const tool = (status, extra = {}) => ({ type: 'message.part.updated', properties: { part: { type: 'tool', sessionID: 'SECRET_SESSION', callID: 'SECRET_CALL', tool: 'bash', state: { status, input: { command: 'PRIVATE_COMMAND' }, output: 'PRIVATE_OUTPUT', error: 'PRIVATE_ERROR' }, ...extra } } });
const status = type => ({ type: 'session.status', properties: { sessionID: 'SECRET_SESSION', status: { type } } });
const ok = () => new Response('{}');

test('mapper uses the actual nested tool payload and emits Kitchen kinds, never raw data', () => {
  const mapper = createEventMapper();
  const start = mapper.map(tool('running', { tool: 'private_tool_name' }))[0];
  assert.equal(start.kind, 'tool-start');
  assert.equal(start.tool, 'tool');
  assert.match(start.sessionId, /^[a-f0-9]{32}$/);
  assert.match(start.toolId, /^[a-f0-9]{32}$/);
  assert.doesNotMatch(JSON.stringify(start), /SECRET|PRIVATE|private_tool/);
  assert.deepEqual(mapper.map(tool('running', { tool: 'private_tool_name' })), []);
  const end = mapper.map(tool('error'))[0];
  assert.equal(end.kind, 'tool-end');
  assert.equal(end.error, true);
  assert.equal(end.toolId, start.toolId);
  assert.equal(mapper.map(tool('completed', { callID: 'other' }))[0].error, undefined);
});

test('native todo state is authoritative; failed tool calls cannot fabricate tasks', () => {
  const mapper = createEventMapper();
  const failed = mapper.map(tool('error', { tool: 'todowrite' }))[0];
  assert.equal(failed.tasks, undefined);
  const update = mapper.map({ type: 'todo.updated', properties: { sessionID: 's', todos: [
    { id: 'private-id', content: 'PRIVATE_TITLE', status: 'in_progress' },
    { content: 'PRIVATE_TITLE', status: 'completed' },
    { content: 'PRIVATE_TITLE', status: 'cancelled' },
    { content: 'PRIVATE_TITLE', status: 'bogus' },
  ] } })[0];
  assert.deepEqual(update.tasks.map(t => [t.title, t.status]), [['Task 1', 'in_progress'], ['Task 2', 'completed']]);
  assert.doesNotMatch(JSON.stringify(update), /PRIVATE|private-id|cancelled|bogus/);
  assert.deepEqual(mapper.map({ type: 'todo.updated', properties: { sessionID: 's', todos: [] } })[0].tasks, []);
  assert.equal(mapper.map({ type: 'todo.updated', properties: { sessionID: 's', todos: Array(40).fill({ status: 'pending' }) } })[0].tasks.length, 24);
});

test('busy resumes each turn, idle is input, retries/errors and permission remain truthful', () => {
  const mapper = createEventMapper();
  assert.equal(mapper.map(status('busy'))[0].kind, 'turn-start');
  assert.deepEqual(mapper.map(status('busy')), []);
  assert.equal(mapper.map(status('idle'))[0].kind, 'input');
  assert.equal(mapper.map(status('busy'))[0].kind, 'turn-start');
  assert.equal(mapper.map(status('retry'))[0].kind, 'unknown');
  for (const type of ['permission.updated', 'permission.asked']) assert.equal(mapper.map({ type, properties: { sessionID: 's', title: 'SECRET', pattern: 'PRIVATE' } })[0].kind, 'permission');
  assert.equal(mapper.map({ type: 'permission.replied', properties: { sessionID: 's' } })[0].kind, 'unknown');
  assert.equal(mapper.map({ type: 'session.error', properties: { sessionID: 's', error: { name: 'MessageAbortedError', data: { message: 'PRIVATE' } } } })[0].kind, 'interrupted');
  assert.equal(mapper.map({ type: 'session.error', properties: { sessionID: 's' } })[0].error, true);
  assert.match(mapper.map({ type: 'session.created', properties: { info: { id: 'child', parentID: 'parent', directory: '/wrong', title: 'PRIVATE' } } })[0].parentId, /^[a-f0-9]{32}$/);
  assert.deepEqual(mapper.map({ type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 's', text: 'PRIVATE' } } }), []);
});

test('private registration is bounded and rejects malformed tokens, modes, symlinks and hardlinks', async t => {
  const { home, file } = await fixture(t);
  assert.equal((await readRegistration(home)).port, 43210);
  await chmod(file, 0o644);
  await assert.rejects(readRegistration(home));
  await chmod(file, 0o600);
  const bytes = await readFile(file);
  await writeFile(file, JSON.stringify({ port: 43210, pid: 1, token: 'a'.repeat(48) }));
  await assert.rejects(readRegistration(home));
  await writeFile(file, 'a'.repeat(4097));
  await assert.rejects(readRegistration(home));
  await writeFile(file, bytes);
  await link(file, join(home, 'hardlink'));
  await assert.rejects(readRegistration(home));
  await unlink(join(home, 'hardlink'));
  await unlink(file);
  await writeFile(join(home, 'target'), bytes, { mode: 0o600 });
  await symlink(join(home, 'target'), file);
  await assert.rejects(readRegistration(home));
});

test('writable or symlinked state paths fail closed', async t => {
  const { home } = await fixture(t);
  await chmod(join(home, '.local'), 0o777);
  await assert.rejects(readRegistration(home));
  await chmod(join(home, '.local'), 0o755);
  const leaf = join(home, '.local/state/code-harness/agenttrail');
  await rm(leaf, { recursive: true });
  await mkdir(join(home, 'elsewhere'), { mode: 0o700 });
  await symlink(join(home, 'elsewhere'), leaf);
  await assert.rejects(readRegistration(home));
});

test('transport posts ordered metadata to loopback with bearer auth and rejects redirects', async t => {
  const { home, directory } = await fixture(t), requests = [];
  const observer = createOpenCodeObserver({ home, cwd: directory, fetchImpl: async (url, options) => { requests.push({ url, options, body: JSON.parse(options.body) }); return ok(); } });
  observer.observe(tool('running'));
  observer.observe(tool('error'));
  await observer.settled();
  assert.deepEqual(requests.map(r => r.body.kind), ['tool-start', 'tool-end']);
  assert.equal(requests[0].url, 'http://127.0.0.1:43210/api/hook');
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.headers.authorization, `Bearer ${'a'.repeat(48)}`);
  assert.equal(requests[0].body.cwd, directory);
  observer.dispose();
});

test('missing registration or failed requests drop queued work, without throwing or replaying', async t => {
  const { home, directory, file } = await fixture(t);
  const bytes = await readFile(file);
  await unlink(file);
  let requests = 0;
  const observer = createOpenCodeObserver({ home, cwd: directory, fetchImpl: async () => { requests++; throw new Error('offline'); } });
  observer.observe(tool('running')); observer.observe(tool('error'));
  await observer.settled();
  assert.equal(requests, 0);
  await writeFile(file, bytes, { mode: 0o600 });
  observer.observe(tool('running')); observer.observe(tool('error'));
  await observer.settled();
  assert.equal(requests, 1);
  observer.dispose();
});

test('generation rotation discards stale queue and allows subsequent live events', async t => {
  const { home, directory, file } = await fixture(t), bodies = [];
  const observer = createOpenCodeObserver({ home, cwd: directory, fetchImpl: async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    if (bodies.length === 1) await writeFile(file, JSON.stringify({ port: 43210, pid: 124, hookToken: 'b'.repeat(48) }));
    return ok();
  } });
  observer.observe(status('busy')); observer.observe(tool('running')); observer.observe(tool('error'));
  await observer.settled();
  assert.equal(bodies.length, 1);
  observer.observe(tool('running'));
  await observer.settled();
  assert.equal(bodies.length, 2);
  observer.dispose();
});

test('queue is bounded and calls are aborted after 500 ms; plugin hook does not wait for networking', async t => {
  const { home, directory } = await fixture(t);
  let aborted = false, calls = 0;
  const observer = createOpenCodeObserver({ home, cwd: directory, fetchImpl: async (_url, options) => {
    calls++;
    if (calls > 1) return ok();
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true }));
  } });
  const started = Date.now();
  for (let i = 0; i < 200; i++) observer.observe(tool('running', { callID: `call-${i}` }));
  assert.ok(Date.now() - started < 500);
  await observer.settled();
  assert.equal(aborted, true);
  assert.equal(calls, 1);
  observer.dispose();
});

test('plugin exports exact lifecycle and uses canonical directory rather than event cwd', async t => {
  const { home, directory } = await fixture(t), bodies = [];
  const plugin = await createOpenCodePlugin({ home, directory, fetchImpl: async (_url, options) => { bodies.push(JSON.parse(options.body)); return ok(); } });
  await plugin.event({ event: { ...tool('running'), cwd: '/wrong' } });
  for (let i = 0; i < 100 && !bodies.length; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(bodies[0].cwd, await realpath(directory));
  plugin.dispose();
  const inert = await opencodePlugin({ directory: join(home, 'missing') });
  await assert.doesNotReject(inert.event({ event: tool('running') }));
  inert.dispose();
});

test('real local endpoint accepts OpenCode, preserves native todos and shows truthful identity', async t => {
  const { home, directory, stateDir, file } = await fixture(t);
  await unlink(file);
  const office = await startOffice({ roots: [directory], home, stateDir, port: 0, observe: false });
  t.after(() => office.close());
  const observer = createOpenCodeObserver({ home, cwd: directory });
  observer.observe(status('busy'));
  observer.observe(tool('running'));
  observer.observe(tool('error'));
  observer.observe({ type: 'todo.updated', properties: { sessionID: 'SECRET_SESSION', todos: [{ content: 'PRIVATE_TITLE', status: 'in_progress' }] } });
  observer.observe(status('idle'));
  await observer.settled();
  const response = await fetch(office.url + '/api/state');
  const state = await response.json();
  assert.equal(state.observers.opencode.mode, 'metadata plugin');
  const executor = state.executors.find(s => s.provider === 'opencode');
  assert.ok(executor, 'real endpoint must accept the provider');
  assert.equal(executor.state, 'input');
  assert.equal(executor.sessionTasks[0].title, 'Task 1');
  assert.equal(executor.sessionTasks[0].status, 'in_progress');
  assert.equal(providerName.opencode, 'OpenCode');
  assert.match(new IdentityBook().assign([executor])[0].displayName, /^OpenCode /);
  assert.doesNotMatch(JSON.stringify(executor), /SECRET|PRIVATE/);
  observer.dispose();
});
