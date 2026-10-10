import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, lstat, link, symlink, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { readPrivateJson, writePrivateJson } from '../src/private-state.mjs';

let base;
let home;
let stateDir;
const name = 'history.json';
const maxBytes = 128;
const options = () => ({ home, stateDir, name, maxBytes });

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'private-state-'));
  home = path.join(base, 'home');
  stateDir = path.join(home, 'state');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  await chmod(stateDir, 0o700);
});

afterEach(async () => rm(base, { recursive: true, force: true }));

test('missing reads return null; writes are private and readable', async () => {
  assert.equal(await readPrivateJson(options()), null);
  await writePrivateJson({ ...options(), value: { ready: true } });
  assert.deepEqual(await readPrivateJson(options()), { ready: true });
  assert.equal((await lstat(path.join(stateDir, name))).mode & 0o777, 0o600);
});

test('rejects oversized and corrupt files without exposing content', async () => {
  await writeFile(path.join(stateDir, name), 'x'.repeat(maxBytes + 1), { mode: 0o600 });
  await assert.rejects(readPrivateJson(options()), (error) => error.message === 'Private state is unavailable');
  await writeFile(path.join(stateDir, name), 'SECRET-CORRUPT-PAYLOAD{', { mode: 0o600 });
  await assert.rejects(readPrivateJson(options()), (error) => !error.message.includes('SECRET-CORRUPT-PAYLOAD'));
});

test('rejects symlink and hardlink targets', async () => {
  const target = path.join(stateDir, name);
  await symlink(path.join(stateDir, 'missing'), target);
  await assert.rejects(readPrivateJson(options()));
  await assert.rejects(writePrivateJson({ ...options(), value: {} }));
  await rm(target);
  const original = path.join(stateDir, 'other');
  await writeFile(original, '{}', { mode: 0o600 });
  await link(original, target);
  await assert.rejects(readPrivateJson(options()));
  await assert.rejects(writePrivateJson({ ...options(), value: {} }));
});

test('rejects writable directories and paths outside canonical home', async () => {
  await chmod(stateDir, 0o702);
  await assert.rejects(readPrivateJson(options()));
  await chmod(stateDir, 0o700);
  const outside = path.join(base, 'outside');
  await mkdir(outside, { mode: 0o700 });
  await assert.rejects(readPrivateJson({ ...options(), stateDir: outside }));
});

test('rejects path-fragment names and never includes input in errors', async () => {
  await assert.rejects(readPrivateJson({ ...options(), name: '../secret.json' }), (error) => !error.message.includes('secret'));
});
