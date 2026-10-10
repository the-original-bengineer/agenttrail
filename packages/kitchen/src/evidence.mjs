import { createHash } from 'node:crypto';

const categories = new Set(['test', 'build', 'lint', 'review']);
export const evidenceKey = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 32);

export function checkCategory(command) {
  if (Array.isArray(command)) {
    if (command.length === 3 && ['bash', 'sh', 'zsh'].includes(command[0]) && ['-c', '-lc'].includes(command[1])) command = command[2];
    else if (command.every(part => typeof part === 'string' && /^[\w./:-]+$/.test(part))) command = command.join(' ');
    else return null;
  }
  if (typeof command !== 'string' || command.length > 256 || !/^[\w\s./:-]+$/.test(command) || /[\r\n]/.test(command)) return null;
  const words = command.trim().split(/\s+/);
  if (words.some(w => /^--(?:help|version|list|dry-run|collect-only|no-run|watch)/.test(w))) return null;
  let name;
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(words[0])) name = words[1] === 'run' ? words[2] : words[1];
  else if (words[0] === 'node' && ['--test', '--check'].includes(words[1])) name = words[1] === '--test' ? 'test' : 'check';
  else if (['pytest', 'vitest', 'jest'].includes(words[0])) name = 'test';
  else if (['cargo', 'go'].includes(words[0]) && words[1] === 'test') name = 'test';
  return ({ test: 'test', build: 'build', lint: 'lint', typecheck: 'lint', check: 'review' })[name] || null;
}

export function toolCheck(tool, input) {
  if (['bash', 'Bash', 'Shell', 'exec_command', 'shell', 'shell_command'].includes(tool)) return checkCategory(input?.command ?? input?.cmd);
  if (tool === 'workspace_run' && ['npm', 'pnpm', 'yarn', 'bun'].includes(input?.runner)) {
    if (input.action === 'test') return 'test';
    if (input.action === 'run') return ({ test: 'test', build: 'build', lint: 'lint', typecheck: 'lint', check: 'review' })[input.script] || null;
  }
  return null;
}

export function reportedCheck(category, source, { exitCode, failed = false, interrupted = false } = {}) {
  if (!categories.has(category)) return undefined;
  return { category, source, result: interrupted ? 'interrupted' : failed ? 'failed' : Number.isSafeInteger(exitCode) ? exitCode === 0 ? 'passed' : 'failed' : 'unknown' };
}

export function usageValues(value) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const key of ['input', 'output', 'cached', 'reasoning']) {
    if (value[key] === undefined) continue;
    if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 1e12) return null;
    result[key] = value[key];
  }
  return Number.isSafeInteger(result.input) && Number.isSafeInteger(result.output) ? result : null;
}

export class UsageLedger {
  constructor() { this.messages = new Map(); this.latest = null; this.truncated = false; }
  accept(usage, at, source) {
    const values = usageValues(usage?.values);
    if (!values || !['message', 'cumulative'].includes(usage.mode) || !/^[a-f0-9]{32}$/.test(usage.key || '')) return false;
    if (usage.mode === 'cumulative') {
      if (this.latest && at < this.latest.at) return false;
      this.latest = { at, ...values, reset: !!this.latest && (values.input < this.latest.input || values.output < this.latest.output) };
    } else {
      const previous = this.messages.get(usage.key);
      if (previous && at < previous.at) return false;
      if (!previous && this.messages.size >= 2000) { this.truncated = true; return false; }
      this.messages.set(usage.key, { at, ...values });
    }
    this.source = source;
    this.mode = usage.mode;
    return true;
  }
  snapshot() {
    if (!this.mode) return null;
    const values = this.mode === 'cumulative' ? this.latest : [...this.messages.values()].reduce((sum, item) => {
      for (const key of ['input', 'output', 'cached', 'reasoning']) if (item[key] !== undefined) sum[key] = (sum[key] || 0) + item[key];
      return sum;
    }, {});
    const { at, ...metrics } = values;
    return { ...metrics, scope: 'observed-session', source: this.source, partial: this.mode === 'message' || this.truncated, basis: this.mode === 'message' ? 'observed completed messages' : 'latest reported session counter' };
  }
}
