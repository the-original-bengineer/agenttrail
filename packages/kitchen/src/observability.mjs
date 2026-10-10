import { createHash } from 'node:crypto';

export const providers = ['opencode', 'claude', 'codex', 'cursor'];
export const opaque = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
const working = new Set(['reading', 'writing', 'executing', 'working']);
const attention = new Set(['permission', 'input', 'error']);
const tools = { read: 'read', glob: 'search', grep: 'search', safe_search: 'search', webfetch: 'search', websearch: 'search', edit: 'write', write: 'write', apply_patch: 'write', bash: 'execute', workspace_run: 'execute', task: 'task', todowrite: 'task', todoread: 'task' };

export function taskSummary(session) {
  if (!Array.isArray(session.sessionTasks)) return null;
  const tasks = session.sessionTasks;
  return { total: tasks.length, done: tasks.filter(t => t.status === 'completed').length, active: tasks.filter(t => t.status === 'in_progress').length, blocked: 0 };
}

export function sessionSummary(session, now = Date.now()) {
  const recent = now - session.lastEventAt <= 120_000;
  return {
    id: session.id, key: opaque(session.id), provider: session.provider, parentId: session.parentId || null,
    state: session.state, ended: !!session.ended, lastEventAt: session.lastEventAt,
    freshness: recent ? 'recent' : 'quiet', working: !session.ended && recent && working.has(session.state),
    attention: !session.ended && attention.has(session.state), source: ['hook', 'log'].includes(session.source) ? session.source : 'unknown',
    tool: tools[String(session.tool).toLowerCase()] || 'other', tasks: taskSummary(session),
    verification: session.verification || [], usage: session.usage || null,
  };
}

export function overview(projects, executors, { available = {}, installed = {}, observe = true, limited = false, now = Date.now() } = {}) {
  return projects.map(project => {
    const sessions = executors.filter(s => s.project === project.id).map(s => sessionSummary(s, now));
    const live = sessions.filter(s => !s.ended);
    const health = providers.map(provider => {
      const observed = sessions.filter(s => s.provider === provider);
      const lastEventAt = Math.max(0, ...observed.map(s => s.lastEventAt));
      const mode = provider === 'opencode' ? 'metadata plugin' : provider === 'cursor' ? 'hooks' : provider === 'claude' ? 'logs / optional hooks' : 'local logs';
      return {
        provider, mode, status: !observe && ['codex', 'claude'].includes(provider) && !installed[project.id]?.[provider] ? 'logs-disabled' : lastEventAt ? now - lastEventAt <= 120_000 ? 'recent' : 'quiet' : 'unobserved',
        lastEventAt: lastEventAt || null, sessions: observed.filter(s => !s.ended).length,
        configured: ['claude', 'cursor'].includes(provider) ? !!installed[project.id]?.[provider] : null,
        logsAvailable: ['claude', 'codex'].includes(provider) ? !!available[provider] : null,
      };
    });
    return { id: project.id, key: opaque(project.id), name: project.name, sessions, health, liveSessions: live.length, working: live.filter(s => s.working).length, attention: live.filter(s => s.attention).length, lastEventAt: Math.max(0, ...sessions.map(s => s.lastEventAt), ...(project.activity || []).map(a => a.at)) || null, limited };
  });
}

export function historyRecord(session, event) {
  const summary = sessionSummary(session);
  return {
    id: opaque(`${session.provider}:${event.id}`), project: opaque(session.project), session: opaque(session.id),
    provider: session.provider, at: Number(event.at), kind: event.kind === 'usage' ? 'usage' : event.verification ? 'verification' : 'activity',
    state: summary.state, tool: summary.tool,
    ...(summary.tasks ? { tasks: summary.tasks } : {}),
    ...(event.verification ? { verification: event.verification } : {}),
    ...(event.kind === 'usage' && summary.usage ? { usage: summary.usage } : {}),
  };
}
