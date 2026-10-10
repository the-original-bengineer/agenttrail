import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCategory, toolCheck, reportedCheck, UsageLedger, evidenceKey } from '../src/evidence.mjs';
import { createEventMapper } from '../src/opencode/core.mjs';
import { codexEvents, claudeEvents } from '../src/connectors/events.mjs';
import { CrewStore } from '../src/runtime/crew.mjs';
import { overview } from '../src/observability.mjs';

test('checks recognize bounded commands, not compound scripts or tool success', () => {
  assert.equal(checkCategory('npm test'), 'test');
  assert.equal(checkCategory(['bash', '-lc', 'npm run build']), 'build');
  assert.equal(checkCategory(['node', '--test', 'test/a.test.mjs']), 'test');
  for (const command of ['npm test && publish', 'npm test; true', 'npm test --help', 'npm test\ntrue', 'echo passed', ['echo', 'npm test']]) assert.equal(checkCategory(command), null);
  assert.equal(toolCheck('workspace_run', { runner: 'npm', action: 'run', script: 'lint' }), 'lint');
  assert.equal(reportedCheck('test', 'opencode', {}).result, 'unknown');
  assert.equal(reportedCheck('test', 'codex', { exitCode: 0 }).result, 'passed');
  assert.equal(reportedCheck('test', 'codex', { exitCode: 2 }).result, 'failed');
});

test('OpenCode completed message usage and check metadata never export native payloads', () => {
  const mapper = createEventMapper(), now = Date.now(), store = new CrewStore(['/repo']);
  const event = { type: 'message.updated', properties: { info: { id: 'msg_one', sessionID: 'session', role: 'assistant', time: { completed: now }, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 40 } }, cost: 9, structured: 'SECRET-PAYLOAD', path: { cwd: '/secret' } } } };
  const mapped = mapper.map(event); assert.equal(mapped.length, 1); assert.equal(mapper.map(event).length, 0);
  assert.ok(!JSON.stringify(mapped).includes('SECRET')); assert.ok(!JSON.stringify(mapped).includes('cost')); assert.ok(!JSON.stringify(mapped).includes('/secret'));
  for (const item of mapped) store.accept({ ...item, cwd: '/repo', at: now, source: 'hook' });
  assert.equal(store.snapshot()[0].usage.input, 100); assert.equal(store.snapshot()[0].state, 'unknown');
  const tool = mapper.map({ type: 'message.part.updated', properties: { part: { type: 'tool', sessionID: 'session', callID: 'check', tool: 'bash', state: { status: 'completed', input: { command: 'npm test' }, output: 'SECRET-OUTPUT', metadata: {} } } } });
  assert.equal(tool[0].verification.result, 'unknown'); assert.ok(!JSON.stringify(tool).includes('npm test')); assert.ok(!JSON.stringify(tool).includes('SECRET'));
  assert.deepEqual(mapper.map({ ...event, properties: { info: { ...event.properties.info, role: 'user' } } }), []);
  assert.deepEqual(mapper.map({ ...event, properties: { info: { ...event.properties.info, tokens: { input: -1, output: 20 } } } }), []);
});

test('Codex usage is cumulative; correlated completed checks are separate from tool success', () => {
  const store = new CrewStore(['/repo']), meta = { id: 'one', cwd: '/repo' }, now = Date.now(), timestamp = new Date(now).toISOString();
  const send = payload => { for (const event of codexEvents({ type: 'event_msg', timestamp, payload }, meta, 'log')) store.accept(event); };
  send({ type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 30, reasoning_output_tokens: 5 } } });
  send({ type: 'token_count', info: { total_token_usage: { input_tokens: 110, output_tokens: 25, cached_input_tokens: 30, reasoning_output_tokens: 5 } } });
  send({ type: 'token_count', info: { total_token_usage: { input_tokens: 110, output_tokens: 25, cached_input_tokens: 30, reasoning_output_tokens: 5 } } });
  assert.equal(store.snapshot()[0].usage.input, 110);
  send({ type: 'item_completed', item: { id: 'check', type: 'commandExecution', command: ['bash', '-lc', 'npm test'], exit_code: 0, status: 'completed' }, completed_at_ms: now });
  assert.equal(store.snapshot()[0].verification[0].result, 'passed');
  send({ type: 'item_completed', item: { id: 'generic', type: 'commandExecution', command: ['bash', '-lc', 'echo hello'], exit_code: 0, status: 'completed' }, completed_at_ms: now });
  assert.equal(store.snapshot()[0].verification.length, 1);
});

test('Claude correlated Bash completion is unknown, failure is reported and unmatched output adds no evidence', () => {
  const context = { pending: new Map() }, base = { sessionId: 'one', cwd: '/repo', timestamp: new Date().toISOString() };
  claudeEvents({ ...base, uuid: 'start', type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call', name: 'Bash', input: { command: 'npm test' } }] } }, 'log', context);
  const result = claudeEvents({ ...base, uuid: 'end', type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: 'SECRET output' }] } }, 'log', context);
  assert.equal(result[0].verification.result, 'unknown'); assert.ok(!JSON.stringify(result).includes('SECRET'));
  const unmatched = claudeEvents({ ...base, uuid: 'other', type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'unknown', content: 'passed' }] } }, 'log', context);
  assert.equal(unmatched[0].verification, undefined);
});

test('delayed usage enriches past metadata without refreshing activity or reviving an ended session', () => {
  const now = Date.now(), store = new CrewStore(['/repo'], () => now);
  store.accept({ provider: 'codex', sessionId: 'one', cwd: '/repo', id: 'end', at: now, source: 'log', kind: 'session-end' });
  const before = overview([{ id: '/repo', name: 'Repo' }], store.snapshot(), { now });
  store.accept({ provider: 'codex', sessionId: 'one', cwd: '/repo', id: 'usage', at: now - 1000, source: 'log', kind: 'usage', usage: { mode: 'cumulative', key: evidenceKey('one'), values: { input: 100, output: 20 } } });
  const after = overview([{ id: '/repo', name: 'Repo' }], store.snapshot(), { now });
  assert.equal(after[0].sessions[0].lastEventAt, before[0].sessions[0].lastEventAt);
  assert.equal(after[0].sessions[0].ended, true); assert.equal(after[0].liveSessions, 0); assert.equal(after[0].working, 0);
  assert.deepEqual(after[0].health, before[0].health);
  assert.equal(after[0].sessions[0].usage.input, 100);
});

test('usage overwrites repeated message snapshots and cumulative counters without addition', () => {
  const ledger = new UsageLedger(), key = evidenceKey('message');
  ledger.accept({ mode: 'message', key, values: { input: 10, output: 2, cached: 3 } }, 1, 'opencode');
  ledger.accept({ mode: 'message', key, values: { input: 10, output: 2, cached: 3 } }, 1, 'opencode');
  assert.equal(ledger.snapshot().input, 10);
  ledger.accept({ mode: 'message', key, values: { input: 11, output: 3 } }, 2, 'opencode');
  assert.equal(ledger.snapshot().input, 11);
  const cumulative = new UsageLedger();
  cumulative.accept({ mode: 'cumulative', key, values: { input: 100, output: 20 } }, 2, 'codex');
  cumulative.accept({ mode: 'cumulative', key, values: { input: 100, output: 20 } }, 2, 'codex');
  assert.equal(cumulative.snapshot().input, 100);
  cumulative.accept({ mode: 'cumulative', key, values: { input: 5, output: 1 } }, 3, 'codex');
  assert.equal(cumulative.snapshot().input, 5);
  assert.equal(cumulative.snapshot().reset, true);
  assert.equal(cumulative.accept({ mode: 'cumulative', key, values: { input: -1, output: 1 } }, 4, 'codex'), false);
});
