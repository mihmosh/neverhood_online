import assert from 'node:assert/strict';
import test from 'node:test';
import { findGameSource } from '../lib/source.js';

const names = ['a.blb', 'c.blb', 'hd.blb', 'i.blb', 'm.blb', 's.blb', 't.blb'];
const files = prefix => names.map(name => ({ path: `${prefix}/${name}`, file: { name, size: 16 } }));
const record = path => ({ path, file: { name: path.split('/').at(-1), size: 16 } });

test('source discovery finds nested game archives without individual file selection', () => {
  const source = findGameSource([...files('MyGame/DATA'), { path: 'MyGame/NHC.exe', file: { name: 'NHC.exe' } }]);
  assert.equal(source.kind, 'blb');
  assert.deepEqual(source.files.map(file => file.name), names);
  assert.throws(() => findGameSource([...files('one/DATA'), ...files('two/DATA')]), /More than one copy/);
});

test('source discovery pairs an installer with BIN parts in its own directory', () => {
  const source = findGameSource([
    { path: 'download/nested/setup.exe', file: { name: 'setup.exe' } },
    { path: 'download/nested/setup-1.bin', file: { name: 'setup-1.bin' } },
    { path: 'download/unrelated/other.bin', file: { name: 'other.bin' } },
    { path: 'download/nested/unins000.exe', file: { name: 'unins000.exe' } },
  ]);
  assert.equal(source.kind, 'installer');
  assert.deepEqual(source.files.map(file => file.name), ['setup.exe', 'setup-1.bin']);
  assert.equal(findGameSource([{ name: 'setup.exe', webkitRelativePath: 'game/setup.exe' }]).kind, 'installer');
  assert.throws(() => findGameSource([{ path: 'one/setup.exe', file: {} }, { path: 'two/setup.exe', file: {} }]), /More than one installer/);
});

test('source discovery rejects ambiguity, traversal and incomplete resources', () => {
  assert.throws(() => findGameSource([]), /Choose/);
  assert.throws(() => findGameSource(files('game').slice(1)), /could not find/);
  assert.throws(() => findGameSource([...files('game'), { path: 'GAME/A.BLB', file: {} }]), /duplicate/);
  for (const path of ['../setup.exe', '/setup.exe', 'C:\\setup.exe']) assert.throws(() => findGameSource([{ path, file: {} }]), /unsafe/);
});

test('source discovery prefers matching BIN parts over bundled runtime installers', () => {
  const source = findGameSource([
    'The_Neverhood/The_Neverhood/The Neverhood_Repack_Setup.exe',
    'The_Neverhood/The_Neverhood/The Neverhood_Repack_Setup-1.bin',
    'The_Neverhood/_Redist/dxwebsetup.exe',
    'The_Neverhood/_Redist/oalinst.exe',
    'The_Neverhood/_Redist/vcredist_2015-2019_x64.exe',
    'The_Neverhood/_Redist/vcredist_2015-2019_x86.exe',
    'The_Neverhood/_Redist/vcredist_x64.exe',
    'The_Neverhood/_Redist/vcredist_x86.exe',
  ].map(record));
  assert.equal(source.kind, 'installer');
  assert.deepEqual(source.files.map(file => file.name), ['The Neverhood_Repack_Setup.exe', 'The Neverhood_Repack_Setup-1.bin']);
});

test('split installer discovery selects only its own adjacent BIN parts', () => {
  const source = findGameSource(['game/setup.exe', 'game/setup-1.bin', 'game/setup-2a.bin', 'game/other.bin', 'game/dxwebsetup.exe', 'elsewhere/setup-3.bin'].map(record));
  assert.deepEqual(source.files.map(file => file.name), ['setup.exe', 'setup-1.bin', 'setup-2a.bin']);
  assert.throws(() => findGameSource(['one/setup.exe', 'one/setup-1.bin', 'two/setup.exe', 'two/setup-1.bin'].map(record)), /More than one installer/);
});
