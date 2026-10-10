import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

const SAFE_ERROR = 'Private state is unavailable';
const MAX_BYTES = 10 * 1024 * 1024;
const uid = typeof process.getuid === 'function' ? process.getuid() : null;

function fail() {
  throw new Error(SAFE_ERROR);
}

function checkName(name) {
  if (typeof name !== 'string' || !/^[a-z-]+\.json$/.test(name)) fail();
}

async function checkDirectory({ stateDir, home }) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir) || typeof home !== 'string' || !path.isAbsolute(home)) fail();
  let root;
  let absolute;
  let relative;
  try {
    root = await realpath(home);
    absolute = path.resolve(stateDir);
    relative = path.relative(path.resolve(home), absolute);
  } catch {
    fail();
  }
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail();
  const rootInfo = await lstat(root).catch(() => null);
  if (!rootInfo?.isDirectory() || (uid !== null && rootInfo.uid !== uid) || (rootInfo.mode & 0o022) !== 0) fail();
  let current = relative ? root : path.dirname(root);
  const components = relative ? relative.split(path.sep) : [path.basename(root)];
  for (let i = 0; i < components.length; i += 1) {
    current = path.join(current, components[i]);
    let stat;
    try { stat = await lstat(current); } catch { fail(); }
    const isLeaf = i === components.length - 1;
    if (stat.isSymbolicLink() || !stat.isDirectory() || (uid !== null && stat.uid !== uid) || (stat.mode & 0o022) !== 0) fail();
    if (isLeaf && (stat.mode & 0o777) !== 0o700) fail();
  }
  return { directory: current, root };
}

async function checkTarget(file) {
  let stat;
  try { stat = await lstat(file); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    fail();
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (uid !== null && stat.uid !== uid) || (stat.mode & 0o777) !== 0o600) fail();
  return stat;
}

export async function readPrivateJson({ stateDir, home, name, maxBytes }) {
  checkName(name);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_BYTES) fail();
  const { directory } = await checkDirectory({ stateDir, home });
  const file = path.join(directory, name);
  const stat = await checkTarget(file);
  if (!stat) return null;
  if (stat.size > maxBytes) fail();
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || (uid !== null && opened.uid !== uid) || (opened.mode & 0o777) !== 0o600 || opened.size > maxBytes || opened.ino !== stat.ino || opened.dev !== stat.dev) fail();
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) fail();
    try { return JSON.parse(buffer.subarray(0, length).toString('utf8')); } catch { fail(); }
  } catch (error) {
    if (error?.message === SAFE_ERROR) throw error;
    fail();
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function writePrivateJson({ stateDir, home, name, value, maxBytes }) {
  checkName(name);
  let text;
  try { text = JSON.stringify(value); } catch { fail(); }
  return writePrivateBytes({ stateDir, home, name, text, maxBytes });
}

export async function writeDashboardFile({ stateDir, home, text }) {
  if (typeof text !== 'string') fail();
  await writePrivateBytes({ stateDir, home, name: 'dashboard.html', text, maxBytes: 16000 });
  return path.join(stateDir, 'dashboard.html');
}

async function writePrivateBytes({ stateDir, home, name, text, maxBytes }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_BYTES) fail();
  let bytes;
  try { bytes = Buffer.from(text); } catch { fail(); }
  if (bytes.length > maxBytes) fail();
  const { directory } = await checkDirectory({ stateDir, home });
  const file = path.join(directory, name);
  await checkTarget(file);
  const temp = path.join(directory, `.${name}.${randomBytes(16).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await checkDirectory({ stateDir, home });
    await checkTarget(file);
    await rename(temp, file);
    const dirHandle = await open(directory, constants.O_RDONLY);
    try { await dirHandle.sync(); } finally { await dirHandle.close(); }
  } catch {
    fail();
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temp).catch(() => {});
  }
}
