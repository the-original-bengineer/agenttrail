import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { toolCheck, reportedCheck, usageValues } from '../evidence.mjs';

const LIMIT = 256;
const TOOLS = new Set(['read', 'edit', 'write', 'bash', 'glob', 'grep', 'task', 'webfetch', 'websearch', 'todowrite', 'todoread', 'apply_patch', 'safe_search', 'workspace_run', 'question']);
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
function remember(map, key, value) {
  if (!map.has(key) && map.size >= LIMIT) map.delete(map.keys().next().value);
  map.set(key, value);
}

export async function validateStateDirectory(home = homedir()) {
  const uid = process.getuid?.();
  const realHome = await realpath(home);
  let cursor = realHome;
  const parts = ['.local', 'state', 'code-harness', 'agenttrail'];
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part);
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o022) || (index === parts.length - 1 && (info.mode & 0o077))) throw new Error('Unsafe Kitchen state directory');
  }
  return cursor;
}

export async function readRegistration(home = homedir()) {
  const uid = process.getuid?.();
  const cursor = await validateStateDirectory(home);
  const handle = await open(join(cursor, 'server.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== uid || (info.mode & 0o777) !== 0o600 || info.size > 4096) throw new Error('Unsafe Kitchen registration');
    const bytes = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 4096) throw new Error('Oversized Kitchen registration');
    const registration = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    if (!Number.isSafeInteger(registration.port) || registration.port < 1024 || registration.port > 65535 || !Number.isSafeInteger(registration.pid) || registration.pid < 1 || typeof registration.hookToken !== 'string' || !/^[a-f0-9]{48}$/.test(registration.hookToken)) throw new Error('Invalid Kitchen registration');
    return registration;
  } finally { await handle.close(); }
}

export function createEventMapper() {
  const seen = new Map(), states = new Map();
  return {
    reset() { seen.clear(); states.clear(); },
    map(event) {
      const props = event?.properties;
      if (!props || typeof props !== 'object') return [];
      const nativeSession = event.type === 'message.part.updated' ? props.part?.sessionID : event.type === 'message.updated' ? props.info?.sessionID : props.sessionID ?? props.info?.id;
      if (!identifier(nativeSession)) return [];
      const sessionId = hash(nativeSession);
      const make = (kind, extra = {}) => ({ provider: 'opencode', sessionId, id: randomUUID(), kind, ...extra });
      if (event.type === 'message.updated') {
        const info=props.info;
        if(info?.role!=='assistant'||!identifier(info.id)||!Number.isFinite(info.time?.completed))return [];
        const values=usageValues({input:info.tokens?.input,output:info.tokens?.output,cached:info.tokens?.cache?.read,reasoning:info.tokens?.reasoning});
        if(!values)return [];
        const key=hash(info.id),id=hash(`${sessionId}:${key}:${JSON.stringify(values)}`);
        if(seen.has(id))return [];remember(seen,id,true);
        return [make('usage',{id,usage:{mode:'message',key,values}})];
      }
      if (event.type === 'message.part.updated') {
        const part = props.part;
        if (part?.type !== 'tool' || !identifier(part.callID) || !['running', 'completed', 'error'].includes(part.state?.status)) return [];
        const key = `${sessionId}:${hash(part.callID)}:${part.state.status}`;
        if (seen.has(key)) return [];
        remember(seen, key, true);
        const tool = TOOLS.has(part.tool) ? part.tool : 'tool';
        const category=toolCheck(tool,part.state.input),verification=part.state.status==='running'?undefined:reportedCheck(category,'opencode',{failed:part.state.status==='error',interrupted:part.state.metadata?.interrupted===true});
        return [make(part.state.status === 'running' ? 'tool-start' : 'tool-end', { toolId: hash(part.callID), tool, ...(verification?{verification}:{}), ...(part.state.status === 'error' ? { error: true } : {}) })];
      }
      if (event.type === 'session.status' || event.type === 'session.idle') {
        const status = event.type === 'session.idle' ? 'idle' : props.status?.type;
        if (!['busy', 'idle', 'retry'].includes(status) || states.get(sessionId) === status) return [];
        remember(states, sessionId, status);
        return [make(status === 'busy' ? 'turn-start' : status === 'idle' ? 'input' : 'unknown')];
      }
      if (['permission.updated', 'permission.asked'].includes(event.type)) return [make('permission')];
      if (event.type === 'permission.replied') return [make('unknown')];
      if (event.type === 'session.created') return [make('unknown', identifier(props.info?.parentID) ? { parentId: hash(props.info.parentID) } : {})];
      if (event.type === 'session.deleted') { states.delete(sessionId); return [make('session-end')]; }
      if (event.type === 'session.error') return [make(props.error?.name === 'MessageAbortedError' ? 'interrupted' : 'turn-end', { error: true })];
      if (event.type === 'todo.updated' && Array.isArray(props.todos)) {
        const tasks = props.todos.slice(0, 24).flatMap((todo, index) => ['pending', 'in_progress', 'completed'].includes(todo?.status) ? [{ id: hash(`${nativeSession}:todo:${identifier(todo.id) ? todo.id : index}`), title: `Task ${index + 1}`, status: todo.status }] : []);
        return [make('activity', { tool: 'todowrite', tasks })];
      }
      return [];
    },
  };
}

export function createOpenCodeObserver({ home = homedir(), fetchImpl = globalThis.fetch, cwd } = {}) {
  const mapper = createEventMapper(), queue = [];
  let draining = false, closed = false, registrationKey, controller;
  async function run() {
    if (draining || closed) return;
    draining = true;
    try {
      while (queue.length && !closed) {
        const { event, expiresAt } = queue.shift();
        if (Date.now() > expiresAt) continue;
        let registration;
        try { registration = await readRegistration(home); } catch { queue.length = 0; registrationKey = undefined; mapper.reset(); continue; }
        const key = `${registration.port}:${registration.pid}:${registration.hookToken}`;
        if (registrationKey !== undefined && registrationKey !== key) { queue.length = 0; mapper.reset(); registrationKey = key; continue; }
        registrationKey = key;
        if (closed || Date.now() > expiresAt) continue;
        controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 500);
        try {
          const response = await fetchImpl(`http://127.0.0.1:${registration.port}/api/hook`, {
            method: 'POST', redirect: 'error', signal: controller.signal,
            headers: { authorization: `Bearer ${registration.hookToken}`, 'content-type': 'application/json' },
            body: JSON.stringify({ ...event, cwd }),
          });
          await response?.body?.cancel();
          if (!response?.ok) { queue.length = 0; mapper.reset(); }
        } catch { queue.length = 0; mapper.reset(); }
        finally { clearTimeout(timeout); controller = undefined; }
      }
    } finally { draining = false; }
  }
  return {
    observe(event) {
      if (closed) return;
      // Only allowlisted metadata enters the queue; raw bus events are never retained.
      for (const record of mapper.map(event)) {
        if (queue.length >= 64) queue.shift();
        queue.push({ event: record, expiresAt: Date.now() + 2000 });
      }
      void run().catch(() => { queue.length = 0; mapper.reset(); });
    },
    dispose() { closed = true; controller?.abort(); queue.length = 0; mapper.reset(); },
    async settled() { while (draining) await new Promise(resolve => setTimeout(resolve, 5)); },
  };
}
