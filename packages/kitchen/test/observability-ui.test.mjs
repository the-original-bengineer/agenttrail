import test from 'node:test';
import assert from 'node:assert/strict';
import { setupObservability } from '../public/src/observability-ui.js';

// Minimal controls exercise event wiring; this is not a browser/layout substitute.
test('dialog saves selected settings, preserves drafts/focus, wires every project and guards disconnects', async t => {
  const previous = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
  t.after(() => Object.assign(globalThis, previous));
  const document = { activeElement: null, getElementById: id => elements.get(id) };
  class Control {
    constructor(id = '', attributes = '') { this.id = id; this.value = /\bvalue="([^"]*)"/.exec(attributes)?.[1] || ''; this.checked = /\bchecked\b/.test(attributes); this.type = id === 'obs-session' ? 'text' : ''; this.dataset = {}; this.options = []; this.handlers = {}; }
    addEventListener(name, callback) { this.handlers[name] = callback; }
    focus() { document.activeElement = this; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  }
  const elements = new Map(['observability-dialog', 'observability-panel', 'observability-open', 'observability-close'].map(id => [id, new Control(id)]));
  const panel = elements.get('observability-panel'), dialog = elements.get('observability-dialog');
  dialog.showModal = () => { dialog.open = true; }; dialog.close = () => { dialog.open = false; dialog.handlers.close?.(); };
  panel.controls = new Map(); panel.navigation = [];
  panel.contains = control => !!control && [...panel.controls.values()].includes(control);
  panel.querySelector = selector => selector === '[data-navigate]' ? panel.navigation[0] : panel.controls.get(selector.slice(1));
  panel.querySelectorAll = selector => selector === '[data-navigate]' ? panel.navigation : [];
  Object.defineProperty(panel, 'innerHTML', { get() { return this.markup; }, set(markup) {
    this.markup = markup; this.controls = new Map(); this.navigation = [];
    for (const match of markup.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) this.controls.set(match[1], new Control(match[1], match[0]));
    for (const match of markup.matchAll(/<select[^>]+id="([^"]+)"[^>]*>(.*?)<\/select>/g)) {
      const control = this.controls.get(match[1]); control.options = [...match[2].matchAll(/value="([^"]*)"/g)].map(option => ({ value: option[1] }));
    }
    for (const match of markup.matchAll(/data-navigate="([^"]+)"/g)) { const control = new Control(); control.dataset.navigate = match[1]; this.navigation.push(control); }
  } });
  globalThis.document = document; globalThis.window = { confirm: () => true };
  let connected = true, authorization = 'a'.repeat(48), summary = { enabled: false, retentionDays: 7, count: 0 }, posts = [];
  const projects = ['/alpha', '/beta'].map((id, index) => ({ id, key: String(index + 1).repeat(32), name: id, liveSessions: 0, working: 0, attention: 0, health: [], sessions: [] }));
  globalThis.fetch = async (url, options = {}) => {
    if (options.method === 'POST') { const body = JSON.parse(options.body); posts.push({ url, body }); if (url.endsWith('settings')) summary = { ...summary, ...body }; return { ok: true, json: async () => summary }; }
    return { ok: true, json: async () => ({ summary, records: [] }) };
  };
  const selected = [], ui = setupObservability({ getData: () => ({ overview: projects, history: summary }), getToken: () => 'synthetic-token', getHistoryToken: () => authorization, isConnected: () => connected, onProject: id => selected.push(id) });
  elements.get('observability-open').onclick(); await new Promise(setImmediate);
  let enabled = panel.querySelector('#obs-enabled'); enabled.checked = true; enabled.onchange({ target: enabled });
  let retention = panel.querySelector('#obs-retention'); retention.value = '3'; retention.onchange({ target: retention });
  ui.render(); assert.equal(panel.querySelector('#obs-enabled').checked, true); assert.equal(panel.querySelector('#obs-retention').value, '3');
  await panel.querySelector('#obs-save').onclick(); assert.deepEqual(posts[0].body, { enabled: true, retentionDays: 3 });
  const input = panel.querySelector('#obs-session'); input.value = 'a1b2'; input.setSelectionRange(2, 2); input.focus(); ui.render();
  assert.equal(document.activeElement.id, 'obs-session'); assert.equal(panel.querySelector('#obs-session').value, 'a1b2'); assert.equal(document.activeElement.selectionStart, 2);
  assert.equal(panel.navigation.length, 3); for (const button of panel.navigation) assert.equal(typeof button.handlers.click, 'function');
  const beta = panel.navigation.find(button => button.dataset.navigate === '/beta'); beta.handlers.click({ currentTarget: beta }); assert.equal(selected[0], '/beta');
  connected = false; ui.render(); const count = posts.length; await panel.querySelector('#obs-save').onclick(); assert.equal(posts.length, count); assert.match(panel.markup, /<fieldset disabled>/);
  connected = true; authorization = ''; ui.render(); await panel.querySelector('#obs-save').onclick(); assert.equal(posts.length, count); assert.match(panel.markup, /History locked/); assert.match(panel.markup, /<fieldset disabled>/);
});
