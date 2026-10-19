// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseLayouts } from '../scripts/generate-render-abi.mjs';

const metadata = JSON.parse(readFileSync(new URL('../web/prototype/render-abi.json', import.meta.url)));
const dump = new URL('../scripts/.build/neverhood-web/render-abi/screen.layouts.txt', import.meta.url);

test('generated layouts are bound to the actual pinned wasm32 artifact', () => {
  const wasm = readFileSync(new URL('../web/public/runtime/scummvm.wasm', import.meta.url));
  assert.equal(metadata.schemaVersion, 1);
  assert.equal(metadata.sourceRevision, 'c546a4c80d2daf3bb1d5a3652279e26f762c0204');
  assert.equal(metadata.emsdk, '4.0.10');
  assert.equal(metadata.pointerSize, 4);
  assert.equal(metadata.littleEndian, true);
  assert.equal(metadata.wasmBytes, wasm.length);
  assert.equal(metadata.wasmSHA256, createHash('sha256').update(wasm).digest('hex'));
  assert.notEqual(metadata.wasmSHA256, createHash('sha256').update(wasm.subarray(1)).digest('hex'));
  assert.equal(metadata.enginePointer.baseOffset, 0);
});

test('parser preserves actual Clang offsets without nested-field leakage', { skip: !existsSync(dump) }, () => {
  const records = parseLayouts(['screen', 'gamemodule', 'modules-module1000', 'mouse', 'scene'].map(unit => readFileSync(new URL(`../scripts/.build/neverhood-web/render-abi/${unit}.layouts.txt`, import.meta.url), 'utf8')).join('\n'));
  for (const name of ['Neverhood::RenderItem', 'Neverhood::Screen', 'Neverhood::NeverhoodEngine', 'Graphics::Surface', 'Graphics::PixelFormat', 'Common::Array<Neverhood::RenderItem>']) {
    assert.deepEqual(records[name], metadata.records[name]);
  }
  assert.equal(records['Neverhood::NeverhoodEngine'].bases.Engine, 0);
  assert.equal(records['Neverhood::NeverhoodEngine'].fields.sceneNum, undefined);
  assert.equal(records['Graphics::Surface'].fields.bytesPerPixel, undefined);
  assert.equal(records['Graphics::Surface'].fields.pixels.offset, 8);
  assert.equal(records['Graphics::Surface'].fields._pixels, undefined);
});

test('generated commands compile only existing source and never emit objects or dependencies', () => {
  assert.equal(metadata.commands.length, 5);
  for (const { command, cwd } of metadata.commands) {
    assert.match(cwd, /scripts\/\.build\/neverhood-web$/);
    assert.match(command, / -fsyntax-only /);
    assert.match(command, / -Xclang -fdump-record-layouts /);
    assert.doesNotMatch(command, /(?:^| )-(?:c|o|MMD|MF|MQ|MP)(?: |$)/);
    assert.match(command, /scummvm\/engines\/neverhood\/(?:screen|gamemodule|modules\/module1000|mouse|scene)\.cpp"$/);
  }
});

test('cursor layouts and palette evidence come from stock source, without adding cursor to scene parity', () => {
  for (const [name, field] of [['Neverhood::Scene', '_mouseCursor'], ['Neverhood::Sprite', '_surface'], ['Common::SharedPtr<Neverhood::BaseSurface>', '_pointer'], ['Neverhood::BaseSurface', '_surface'], ['Neverhood::NDrawRect', 'x']]) assert.ok(metadata.records[name].fields[field]);
  assert.match(metadata.cursor.parity, /excluded/);
  assert.match(metadata.cursor.palette, /disables|disabled/);
  assert.equal(metadata.records['Neverhood::Mouse'].bases['Neverhood::StaticSprite'], 0);
  assert.equal(metadata.records['Neverhood::StaticSprite'].bases['Neverhood::Sprite'], 0);
});

test('first-room metadata explicitly excludes menus, video and stale queues', () => {
  assert.equal(metadata.firstRoom.room, 1001);
  assert.equal(metadata.firstRoom.module, 1000);
  assert.equal(metadata.firstRoom.scene, 0);
  const checks = metadata.firstRoom.checks.join('\n');
  for (const field of ['_prevChildObject', '_smackerDecoder', '_fullRefresh', '_sceneNum']) assert.ok(checks.includes(field));
  assert.match(checks, /exactly match/);
  assert.equal(metadata.frameQueue.completed, '_prevRenderQueue');
  assert.equal(metadata.frameQueue.palette.stride, 4);
});
