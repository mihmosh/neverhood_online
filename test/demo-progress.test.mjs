import assert from 'node:assert/strict';
import test from 'node:test';
import { createDemoProgress } from '../web/lib/demo-progress.js';

test('startup is byte-weighted, monotonic and reserves completion for first paint', () => {
  const events = [];
  const update = createDemoProgress({ nativeBytes: 108, roomBytes: 29 }, (...args) => events.push(args));
  assert.equal(update('engine', 1, 'Engine ready'), 6);
  const room = update('room', 1, 'Room downloaded');
  assert.equal(room, 6 + 88 * 29 / 137);
  assert.equal(update('room', 0.25, 'Late callback'), room);
  const verified = update('verify', 1, 'Cache ready');
  assert.equal(verified, room + 4);
  assert.equal(update('native', 1, 'Data ready'), 98);
  assert.equal(update('ready', 0, 'Starting'), 98);
  assert.equal(update('ready', 1, 'Playing'), 100);
  assert.equal(update('engine', 0, 'Late callback'), 100);
  assert.ok(events.every(event => event[2] === 'loading'));
  assert.ok(events.every((event, index) => !index || event[1] >= events[index - 1][1]));
});

test('invalid progress cannot poison the progress indicator', () => {
  const update = createDemoProgress({ nativeBytes: 0, roomBytes: 0 }, () => {});
  assert.equal(update('native', NaN, ''), 0);
  assert.equal(update('missing', 1, ''), 0);
  assert.equal(update('engine', -1, ''), 0);
  assert.equal(update('engine', 2, ''), 6);
});
