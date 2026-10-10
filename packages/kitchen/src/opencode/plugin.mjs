import { realpath } from 'node:fs/promises';
import { createOpenCodeObserver } from './core.mjs';

export async function createOpenCodePlugin({ directory, home, fetchImpl } = {}) {
  let observer;
  try {
    const canonicalDirectory = await realpath(directory);
    observer = createOpenCodeObserver({ home, fetchImpl, cwd: canonicalDirectory });
  } catch {
    observer = { observe: async () => {}, dispose: () => {} };
  }
  return {
    event: async ({ event } = {}) => {
      try { await observer.observe(event); } catch { /* Never interfere with coding. */ }
    },
    dispose: () => observer.dispose(),
  };
}

export default async function opencodePlugin({ directory } = {}) {
  return createOpenCodePlugin({ directory });
}
