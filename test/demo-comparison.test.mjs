import assert from 'node:assert/strict';
import test from 'node:test';
import { initComparison } from '../web/hd-demo/comparison.js';

class Element extends EventTarget {
  dataset = {};
  attributes = new Map();
  properties = new Map();
  style = { setProperty: (key, value) => this.properties.set(key, value) };
  value = '50';
  naturalWidth = 1416;
  naturalHeight = 1062;
  setAttribute(key, value) { this.attributes.set(key, value); }
  removeAttribute(key) { this.attributes.delete(key); }
  getBoundingClientRect() { return { left: 100, width: 400 }; }
  fire(type, fields = {}) {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, fields);
    this.dispatchEvent(event);
    return event;
  }
}
function setup(options = {}) {
  const nodes = Object.fromEntries(['stage', 'original', 'hd', 'range', 'status'].map(name => [name, new Element()]));
  const root = { getElementById: id => nodes[id.replace('comparison-', '')] };
  const cleanup = initComparison({ originalURL: '/original.webp', hdURL: '/hd.webp', root, ...options });
  const ready = () => { nodes.original.fire('load'); nodes.hd.fire('load'); };
  return { ...nodes, cleanup, ready };
}

test('import and absent markup require no global DOM or side effects', () => {
  assert.equal(typeof initComparison({ root: { getElementById: () => null } }), 'function');
});
test('only supplied previews load; both must succeed before revealing images', () => {
  const view = setup();
  assert.equal(view.original.src, '/original.webp');
  assert.equal(view.hd.src, '/hd.webp');
  assert.equal(view.stage.dataset.state, 'loading');
  assert.equal(view.range.disabled, true);
  view.original.fire('load');
  assert.equal(view.original.hidden, true);
  view.hd.fire('load');
  assert.equal(view.stage.dataset.state, 'ready');
  assert.equal(view.range.disabled, false);
  assert.equal(view.status.hidden, true);
  assert.equal(view.original.hidden, false);
  assert.equal(view.range.value, '50');
  view.cleanup();
});
test('range clamps bounds and ignores invalid values', () => {
  const view = setup();
  view.ready();
  for (const [input, expected] of [['-20', '0'], ['150', '100'], ['37', '37'], ['invalid', '37']]) {
    view.range.value = input;
    view.range.fire('input');
    assert.equal(view.stage.properties.get('--comparison-position'), `${expected}%`);
  }
  view.cleanup();
});
test('keyboard Home/End and arrow keys stay within bounds and describe reveal', () => {
  const view = setup();
  view.ready();
  for (const [key, expected] of [['Home', '0'], ['ArrowLeft', '0'], ['ArrowUp', '1'], ['End', '100'], ['ArrowRight', '100'], ['ArrowDown', '99']]) {
    assert.equal(view.range.fire('keydown', { key }).defaultPrevented, true);
    assert.equal(view.range.value, expected);
  }
  assert.equal(view.range.attributes.get('aria-valuetext'), '99% Original, 1% HD');
  assert.equal(view.range.fire('keydown', { key: 'Tab' }).defaultPrevented, false);
  view.cleanup();
});
test('mouse hover maps to full container bounds without resizing an image', () => {
  const view = setup();
  view.ready();
  for (const [clientX, expected] of [[0, '0'], [300, '50'], [600, '100']]) {
    view.stage.fire('pointermove', { pointerType: 'mouse', clientX });
    assert.equal(view.range.value, expected);
  }
  assert.equal(view.original.properties.size, 0);
  view.cleanup();
});
test('touch only moves after horizontal intent, vertical gestures remain scrolling', () => {
  const view = setup();
  view.ready();
  const down = { pointerType: 'touch', pointerId: 1, button: 0, clientX: 300, clientY: 100 };
  view.stage.fire('pointerdown', down);
  view.stage.fire('pointermove', { ...down, clientX: 303, clientY: 130 });
  assert.equal(view.range.value, '50');
  view.stage.fire('pointerdown', down);
  view.stage.fire('pointermove', { ...down, clientX: 400, clientY: 102 });
  assert.equal(view.range.value, '75');
  view.stage.fire('pointercancel', down);
  view.stage.fire('pointermove', { ...down, clientX: 500 });
  assert.equal(view.range.value, '75');
  view.cleanup();
});
test('missing URLs and image errors are accessible, disabled, and never expose broken images', () => {
  const missing = setup({ hdURL: null });
  assert.equal(missing.stage.dataset.state, 'unavailable');
  assert.equal(missing.original.src, undefined);
  assert.equal(missing.range.disabled, true);
  const view = setup();
  view.original.fire('error');
  view.hd.fire('load');
  assert.equal(view.stage.dataset.state, 'error');
  assert.equal(view.stage.attributes.get('aria-busy'), 'false');
  assert.equal(view.original.hidden, true);
  assert.equal(view.hd.hidden, true);
  assert.equal(view.status.hidden, false);
  assert.match(view.status.textContent, /could not be loaded.*still play/);
  view.cleanup();
});
test('cleanup removes handlers and ignores late loads', () => {
  const view = setup();
  view.cleanup();
  view.ready();
  view.stage.fire('pointermove', { pointerType: 'mouse', clientX: 100 });
  assert.equal(view.stage.dataset.state, 'loading');
  assert.equal(view.range.value, '50');
});
