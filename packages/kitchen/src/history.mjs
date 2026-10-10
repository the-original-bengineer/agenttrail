import { readPrivateJson, writePrivateJson } from './private-state.mjs';
import { usageValues } from './evidence.mjs';

const DAY = 86400_000, MAX_RECORDS = 10000, MAX_BYTES = 10 * 1024 * 1024;
const providers = ['opencode', 'codex', 'claude', 'cursor'];
const states = ['reading', 'writing', 'executing', 'working', 'permission', 'input', 'error', 'complete', 'interrupted', 'offline', 'idle', 'unknown'];
const key = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const settingsValid = value => typeof value?.enabled === 'boolean' && Number.isSafeInteger(value.retentionDays) && value.retentionDays >= 1 && value.retentionDays <= 30;

export function sanitizeRecord(value, now = Date.now()) {
  if (!value || !key(value.id) || !key(value.project) || !key(value.session) || !providers.includes(value.provider) || !Number.isFinite(value.at) || value.at <= 0 || value.at > now + 60_000 || !['activity', 'verification', 'usage'].includes(value.kind) || !states.includes(value.state) || !['read', 'write', 'search', 'execute', 'task', 'other'].includes(value.tool)) return null;
  const record = { id: value.id, project: value.project, session: value.session, provider: value.provider, at: value.at, kind: value.kind, state: value.state, tool: value.tool };
  const tasks = value.tasks;
  if (tasks && ['total', 'done', 'active', 'blocked'].every(k => Number.isSafeInteger(tasks[k]) && tasks[k] >= 0 && tasks[k] <= 24) && tasks.done + tasks.active + tasks.blocked <= tasks.total) record.tasks = { total: tasks.total, done: tasks.done, active: tasks.active, blocked: tasks.blocked };
  const check = value.verification;
  if (check && ['test', 'build', 'lint', 'review'].includes(check.category) && ['passed', 'failed', 'interrupted', 'unknown'].includes(check.result) && check.source === value.provider) record.verification = { category: check.category, result: check.result, source: check.source };
  const usage = usageValues(value.usage);
  if (usage && value.usage.source === value.provider) record.usage = { ...usage, scope: 'observed-session', source: value.provider, partial: value.usage.partial === true, reset: value.usage.reset === true };
  if (record.kind === 'verification' && !record.verification || record.kind === 'usage' && !record.usage) return null;
  return record;
}

export class HistoryStore {
  constructor({ stateDir, home, clock = Date.now }) {
    this.location = { stateDir, home, name: 'history.json', maxBytes: MAX_BYTES };
    this.clock = clock; this.enabled = false; this.retentionDays = 7; this.records = []; this.ids = new Set();
    this.truncated = false; this.error = null; this.dirty = false; this.revision = 0; this.queue = Promise.resolve();
    this.recordingSince = clock(); this.clearing = false;
  }
  static async open(options) {
    const store = new HistoryStore(options);
    try {
      const data = await readPrivateJson(store.location);
      if (data === null) return store;
      if (data.version !== 1 || !settingsValid(data) || !Array.isArray(data.records) || data.records.length > MAX_RECORDS) throw new Error();
      const records = data.records.map(record => sanitizeRecord(record, store.clock()));
      if (records.some(record => !record)) throw new Error();
      store.enabled = data.enabled; store.retentionDays = data.retentionDays; store.truncated = data.truncated === true;
      for (const record of records) if (!store.ids.has(record.id)) { store.records.push(record); store.ids.add(record.id); }
      store.prune();
    } catch { store.error = 'History unavailable; recording is disabled. Clear history to recover.'; store.enabled = false; }
    return store;
  }
  prune() {
    const cutoff = this.clock() - this.retentionDays * DAY;
    const previous = this.records.length;
    this.records = this.records.filter(record => record.at >= cutoff);
    if (this.records.length > MAX_RECORDS) { this.records = this.records.slice(-MAX_RECORDS); this.truncated = true; }
    if (this.records.length !== previous) { this.ids = new Set(this.records.map(record => record.id)); this.revision++; this.dirty = true; }
  }
  accept(value) {
    if (!this.enabled || this.clearing || this.error) return false;
    const record = sanitizeRecord(value, this.clock());
    if (!record || record.at < this.recordingSince || this.ids.has(record.id)) return false;
    this.prune(); this.records.push(record); this.ids.add(record.id); this.revision++; this.dirty = true; this.prune();
    return true;
  }
  serialize(overrides = {}) {
    return { version: 1, enabled: this.enabled, retentionDays: this.retentionDays, truncated: this.truncated, records: this.records, ...overrides };
  }
  operation(action) {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }
  async persist(value) {
    try { await writePrivateJson({ ...this.location, value }); this.error = null; }
    catch { this.error = 'History could not be saved. Check the private state directory.'; throw new Error(this.error); }
  }
  flush() {
    return this.operation(async () => {
      this.prune(); if (!this.dirty) return;
      const revision = this.revision;
      await this.persist(this.serialize());
      if (this.revision === revision) this.dirty = false;
    });
  }
  configure(value) {
    if (!settingsValid(value)) return Promise.reject(new Error('Choose history enabled/disabled and retention from 1 to 30 days.'));
    return this.operation(async () => {
      if (this.error) throw new Error('Clear history to recover before enabling recording.');
      const records = this.records.filter(record => record.at >= this.clock() - value.retentionDays * DAY);
      const revision = this.revision;
      await this.persist(this.serialize({ ...value, records }));
      if (value.enabled && !this.enabled) this.recordingSince = this.clock();
      this.enabled = value.enabled; this.retentionDays = value.retentionDays;
      this.prune(); if (this.revision === revision) this.dirty = false;
      return this.summary();
    });
  }
  clear() {
    return this.operation(async () => {
      this.clearing = true;
      try {
        await this.persist(this.serialize({ records: [], truncated: false }));
        this.records = []; this.ids.clear(); this.truncated = false; this.dirty = false; this.revision++;
        this.recordingSince = this.clock();
        return this.summary();
      } finally { this.clearing = false; }
    });
  }
  summary() {
    this.prune();
    return { enabled: this.enabled, retentionDays: this.retentionDays, count: this.records.length, truncated: this.truncated, error: this.error };
  }
  snapshot({ project = '', provider = '', session = '', limit = 200 } = {}) {
    if (project && !key(project) || provider && !providers.includes(provider) || session && !/^[a-f0-9]{1,32}$/.test(session) || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Choose valid history filters and a limit from 1 to 200.');
    const summary = this.summary();
    const records = this.records.filter(record => (!project || record.project === project) && (!provider || record.provider === provider) && (!session || record.session.startsWith(session))).sort((a, b) => b.at - a.at);
    return { summary: { ...summary, truncated: summary.truncated || records.length > limit, matching: records.length }, records: records.slice(0, limit).map(record => structuredClone(record)) };
  }
}
