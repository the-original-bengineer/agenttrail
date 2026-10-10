import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startOffice } from '../src/server.mjs';

test('live overview and private history endpoints preserve auth, source separation and deletion', async t => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'kitchen-observability-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const roots = ['first', 'second'].map(name => path.join(home, name)); for (const root of roots) await fs.mkdir(root);
  const stateDir = path.join(home, 'state'), office = await startOffice({ roots, home, stateDir, port: 0, observe: false });
  t.after(() => office.close());
  const bootstrap = await fetch(office.url + '/api/bootstrap').then(r => r.json());
  const { dashboardToken } = JSON.parse(await fs.readFile(path.join(stateDir, 'server.json')));
  const getHistory = query => fetch(office.url + '/api/history' + (query || ''), { headers: { 'x-history-token': dashboardToken } });
  const post = (endpoint, data, token = bootstrap.token, extra = {}) => fetch(office.url + endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-office-token': token, 'x-history-token': dashboardToken, ...extra }, body: JSON.stringify(data) });
  assert.equal(bootstrap.overview.length, 2); assert.equal(bootstrap.history.enabled, false);
  assert.equal(bootstrap.history.authorized, false); assert.ok(!JSON.stringify(bootstrap).includes(dashboardToken));
  assert.equal((await fetch(office.url + '/api/history')).status, 401);
  assert.equal((await post('/api/history/settings', { enabled: true, retentionDays: 30 }, bootstrap.token, { 'x-history-token': '' })).status, 401);
  assert.equal((await post('/api/history/clear', {}, bootstrap.token, { 'x-history-token': bootstrap.token })).status, 401);
  assert.equal((await post('/api/history/settings', { enabled: true, retentionDays: 7 }, '')).status, 403);
  assert.equal((await post('/api/history/settings', { enabled: true, retentionDays: 7 }, bootstrap.token, { origin: 'https://external.example' })).status, 403);
  assert.equal((await post('/api/history/settings', { enabled: true, retentionDays: 0 })).status, 400);
  assert.equal((await post('/api/history/settings', { enabled: true, retentionDays: 7 })).status, 200);
  office.store.accept({ provider: 'opencode', sessionId: 'one', cwd: roots[0], at: Date.now(), id: 'event', kind: 'tool-start', source: 'hook', tool: 'bash', prompt: 'PRIVATE-SENTINEL', tasks: [{ title: 'PRIVATE-TASK', status: 'in_progress' }] });
  office.store.accept({ provider: 'claude', sessionId: 'two', cwd: roots[1], at: Date.now(), id: 'second', kind: 'permission', source: 'hook' });
  const state = await fetch(office.url + '/api/state').then(r => r.json());
  assert.equal(state.overview[0].liveSessions, 1); assert.equal(state.overview[1].attention, 1);
  assert.equal(state.overview[0].health.find(h => h.provider === 'opencode').status, 'recent');
  assert.ok(!JSON.stringify(state.overview).includes('PRIVATE'));
  assert.equal(state.history.count, 0); assert.equal(state.history.authorized, false);
  const history = await getHistory('?project=' + state.overview[0].key).then(r => r.json());
  assert.equal(history.records.length, 1); assert.ok(!JSON.stringify(history).includes('PRIVATE')); assert.ok(!JSON.stringify(history.records).includes(roots[0]));
  assert.equal((await getHistory('?limit=10000')).status, 400);
  assert.equal((await post('/api/history/clear', {})).status, 200);
  assert.equal((await getHistory().then(r => r.json())).records.length, 0);
  assert.equal(JSON.parse(await fs.readFile(path.join(stateDir, 'history.json'))).records.length, 0);
});

test('unsafe existing registration cannot expose the owner capability through a readable file', async t => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'kitchen-unsafe-registration-'))); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = path.join(home, 'repo'), stateDir = path.join(home, 'state'); await fs.mkdir(root); await fs.mkdir(stateDir, { mode: 0o700 });
  await fs.writeFile(path.join(stateDir, 'server.json'), '{}', { mode: 0o644 });
  await assert.rejects(startOffice({ roots: [root], home, stateDir, port: 0, observe: false }), /Private state/);
  assert.equal(await fs.readFile(path.join(stateDir, 'server.json'), 'utf8'), '{}');
});
