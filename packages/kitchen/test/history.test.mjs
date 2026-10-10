import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HistoryStore, sanitizeRecord } from '../src/history.mjs';

const NOW = 1800000000000;
const record = (n = 1, at = NOW) => ({ id: n.toString(16).padStart(32, '0'), project: 'a'.repeat(32), session: 'b'.repeat(32), provider: 'opencode', at, kind: 'activity', state: 'working', tool: 'other' });
async function fixture(t) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'kitchen-history-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const stateDir = path.join(home, 'state'); await fs.mkdir(stateDir, { mode: 0o700 });
  let now = NOW; const options = { home, stateDir, clock: () => now };
  return { options, stateDir, setNow: value => { now = value; } };
}

test('history is opt-in, does not backfill, deduplicates and survives restart/deletion', async t => {
  const { options, stateDir, setNow } = await fixture(t), store = await HistoryStore.open(options);
  assert.equal(store.summary().enabled, false); assert.equal(store.accept(record()), false);
  assert.deepEqual(await fs.readdir(stateDir), []);
  await store.configure({ enabled: true, retentionDays: 7 });
  assert.equal(store.accept(record(1, NOW - 1)), false);
  assert.equal(store.accept(record()), true); assert.equal(store.accept(record()), false); await store.flush();
  const restored = await HistoryStore.open(options); assert.equal(restored.summary().count, 1);
  await restored.configure({ enabled: false, retentionDays: 7 }); assert.equal(restored.accept(record(2)), false);
  await restored.clear(); assert.equal((await HistoryStore.open(options)).summary().count, 0);
  await restored.configure({ enabled: true, retentionDays: 1 }); restored.accept(record(3)); await restored.flush();
  setNow(NOW + 86400_001); await restored.flush(); assert.equal(restored.summary().count, 0);
});

test('history rejects payloads and retains only allowlisted fields', async t => {
  const { options, stateDir } = await fixture(t), store = await HistoryStore.open(options); await store.configure({ enabled: true, retentionDays: 7 });
  const sentinel = 'SECRET-RAW-CONTENT';
  store.accept({ ...record(), prompt: sentinel, command: sentinel, taskTitle: sentinel, output: sentinel, tasks: { total: 1, done: 0, active: 1, blocked: 0, title: sentinel } });
  store.accept({ ...record(2), kind: 'verification', verification: { category: 'test', source: 'opencode', result: 'unknown', command: sentinel } });
  await store.flush(); assert.ok(!(await fs.readFile(path.join(stateDir, 'history.json'), 'utf8')).includes(sentinel));
  assert.equal(sanitizeRecord({ ...record(3), session: '/secret' }, NOW), null);
  assert.throws(() => store.snapshot({ project: '/repo' }), /filters/);
  assert.throws(() => store.snapshot({ limit: 201 }), /filters/);
});

test('history caps records, bounds queries and serializes clear/configure/flush', async t => {
  const { options } = await fixture(t), store = await HistoryStore.open(options); await store.configure({ enabled: true, retentionDays: 7 });
  for (let n = 1; n <= 10001; n++) store.accept(record(n));
  assert.equal(store.summary().count, 10000); assert.equal(store.summary().truncated, true); assert.equal(store.snapshot({ limit: 50 }).records.length, 50);
  await Promise.all([store.flush(), store.clear(), store.configure({ enabled: false, retentionDays: 7 })]);
  const restored = await HistoryStore.open(options); assert.equal(restored.summary().count, 0); assert.equal(restored.summary().enabled, false);
});

test('corrupt history is safe and requires explicit recovery; unsafe targets cannot be overwritten', async t => {
  const { options, stateDir } = await fixture(t), file = path.join(stateDir, 'history.json');
  await fs.writeFile(file, '{private-secret', { mode: 0o600 });
  const store = await HistoryStore.open(options); assert.equal(store.summary().enabled, false); assert.ok(!store.summary().error.includes('private-secret'));
  await assert.rejects(store.configure({ enabled: true, retentionDays: 7 }), /Clear history/);
  await store.clear(); await store.configure({ enabled: true, retentionDays: 7 });
  await fs.unlink(file); await fs.symlink(path.join(stateDir, 'other'), file);
  await assert.rejects(store.clear(), /could not be saved/);
  assert.ok((await fs.lstat(file)).isSymbolicLink());
});

test('a full session key selects exactly one session while an explicit short prefix can select several', async t => {
  const { options } = await fixture(t), store = await HistoryStore.open(options); await store.configure({ enabled: true, retentionDays: 7 });
  const first = 'a'.repeat(31) + '1', second = 'a'.repeat(31) + '2';
  store.accept({ ...record(1), session: first }); store.accept({ ...record(2), session: second });
  assert.deepEqual(store.snapshot({ session: first }).records.map(r => r.session), [first]);
  assert.equal(store.snapshot({ session: 'a'.repeat(31) }).records.length, 2);
});
