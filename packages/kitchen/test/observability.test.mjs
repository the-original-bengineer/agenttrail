import test from 'node:test';
import assert from 'node:assert/strict';
import { overview, historyRecord } from '../src/observability.mjs';

test('overview counts actual sessions, isolates roots and separates freshness from execution', () => {
  const now = 200000;
  const session = { id: 'opencode:one', project: '/a', provider: 'opencode', state: 'working', lastEventAt: now, source: 'hook', tool: 'bash', sessionTasks: [{ title: 'private task', status: 'in_progress' }] };
  const result = overview([{ id: '/a', name: 'A' }, { id: '/b', name: 'B' }], [session, { ...session, id: 'claude:two', provider: 'claude', state: 'complete', lastEventAt: 1 }, { ...session, id: 'codex:ended', provider: 'codex', ended: true }], { now });
  assert.equal(result[0].liveSessions, 2);
  assert.equal(result[0].working, 1);
  assert.equal(result[1].liveSessions, 0);
  assert.equal(result[0].health.find(h => h.provider === 'claude').status, 'quiet');
  assert.equal(result[1].health.find(h => h.provider === 'opencode').status, 'unobserved');
  assert.equal(result[0].sessions[0].tasks.active, 1);
  assert.ok(!JSON.stringify(result).includes('private task'));
  const record = historyRecord(session, { id: 'event', at: now, kind: 'tool-start', prompt: 'secret' });
  assert.match(record.project, /^[a-f0-9]{32}$/);
  assert.ok(!JSON.stringify(record).includes('/a'));
  assert.ok(!JSON.stringify(record).includes('secret'));
});
