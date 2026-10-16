import assert from 'node:assert/strict';
import test from 'node:test';
import { selectInstaller, parseInstallerListing, MAX_INSTALLER_BYTES } from '../lib/installer-validation.js';

const names = ['a.blb', 'c.blb', 'hd.blb', 'i.blb', 'm.blb', 's.blb', 't.blb'];
const listing = () => names.map(name => `4279716 app/DATA/${name}`);

test('installer selection accepts split or embedded EXE without buffering files', () => {
  const exe = { name: 'The Neverhood_Setup.exe', size: 300000 };
  assert.equal(selectInstaller([exe]).executable, exe.name);
  assert.equal(selectInstaller([exe, { name: 'The Neverhood_Setup-1.bin', size: 600000000 }]).total, 600300000);
  assert.throws(() => selectInstaller([]), /Choose/);
  assert.throws(() => selectInstaller([{ name: 'part.bin', size: 1 }]), /exactly one/);
  assert.throws(() => selectInstaller([exe, { name: exe.name.toUpperCase(), size: 1 }]), /Duplicate/);
  assert.throws(() => selectInstaller([exe, { name: '../part.bin', size: 1 }]), /paths/);
  assert.throws(() => selectInstaller([exe, { name: 'part.bin', size: MAX_INSTALLER_BYTES }]), /2 GiB/);
  assert.throws(() => selectInstaller([exe, { name: 'readme.txt', size: 1 }]), /Unexpected/);
  assert.throws(() => selectInstaller([{ name: 'setup.exe', size: 0 }]), /empty/);
});

test('listing extracts exactly seven safe paths and enforces exact decimal size limits', () => {
  const plan = parseInstallerListing(['Listing "The Neverhood" - setup data version 5.4.2', ...listing(), 'Done.']);
  assert.equal(plan.entries.length, 7);
  assert.equal(plan.entries[0].path, 'app/DATA/a.blb');
  assert.equal(plan.entries[0].upperBytes, 4279716);
  assert.ok(plan.upperBytes < 30 * 1024 ** 2);
  assert.throws(() => parseInstallerListing(listing().slice(1)), /Missing: a.blb/);
  assert.throws(() => parseInstallerListing([...listing(), '1048576 other/A.BLB']), /multiple copies/);
  for (const path of ['../a.blb', '/a.blb', 'app/../a.blb', 'app\\a.blb', 'C:/a.blb']) {
    assert.throws(() => parseInstallerListing([`4194304 ${path}`, ...listing().slice(1)]), /Unsafe|Missing/);
  }
  assert.throws(() => parseInstallerListing(['5368709120 app/a.blb', ...listing().slice(1)]), /archive size/);
  assert.throws(() => parseInstallerListing(listing().map(line => line.replace('4279716', '209715200'))), /1 GiB/);
  assert.throws(() => parseInstallerListing(['unknown app/a.blb', ...listing().slice(1)]), /unsupported/);
});
