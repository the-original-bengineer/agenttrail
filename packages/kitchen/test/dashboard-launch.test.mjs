import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dashboardLaunchFile } from '../bin/office.mjs';

test('owner launch uses a private file path rather than a credential-bearing process argument', async t => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'kitchen-launch-'))); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const stateDir = path.join(home, 'state'); await fs.mkdir(stateDir, { mode: 0o700 });
  const dashboardToken = 'a'.repeat(48); await fs.writeFile(path.join(stateDir, 'server.json'), JSON.stringify({ port: 4780, dashboardToken }), { mode: 0o600 });
  const file = await dashboardLaunchFile('http://127.0.0.1:4780/?project=%2Frepo&mode=live', stateDir, home);
  assert.equal(file, path.join(stateDir, 'dashboard.html')); assert.ok(!file.includes(dashboardToken));
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const html = await fs.readFile(file, 'utf8'); assert.ok(html.includes('#history=' + dashboardToken)); assert.ok(html.includes('no-referrer'));
  await assert.rejects(dashboardLaunchFile('https://external.example/', stateDir, home), /does not match/);
  await fs.unlink(file); await fs.symlink(path.join(home, 'outside'), file);
  await assert.rejects(dashboardLaunchFile('http://127.0.0.1:4780/', stateDir, home), /Private state/);
});
