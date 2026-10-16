// SPDX-License-Identifier: MIT
// Reads installer data only. It never executes or modifies the Windows installer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
// The project is type:module; load the unmodified classic browser bundle as CJS.
const artifact = path.join(root, 'web/public/extractor/innoextract.js');
const loader = new (require('node:module').Module)(artifact);
loader.filename = artifact;
loader.paths = module.paths;
loader._compile(fs.readFileSync(artifact, 'utf8'), artifact + '.cjs');
const createInnoextract = loader.exports;
const input = path.resolve(process.argv[2] || path.join(root, 'original game/The_Neverhood'));
const reference = path.resolve(process.argv[3] || path.join(root, 'extracted/app/DATA'));
const names = ['c.blb', 'hd.blb', 'i.blb', 'm.blb', 's.blb', 't.blb', 'a.blb'];
const common = ['--silent', '--color=false', '--progress=false'];

async function instance(lines) {
  const module = await createInnoextract({ noInitialRun: true, print: line => lines.push(line), printErr: line => console.error(line) });
  assert.equal(typeof module.WORKERFS.mount, 'function');
  module.FS.mkdir('/input');
  module.FS.mount(module.NODEFS, { root: input }, '/input');
  return module;
}

(async () => {
  const installer = fs.readdirSync(input).find(name => /\.exe$/i.test(name));
  assert.ok(installer, 'An installer EXE is required');
  let lines = [];
  let module = await instance(lines);
  assert.equal(module.callMain(['--list', '--list-sizes', ...common, `/input/${installer}`]), 0);
  console.log(lines.join('\n'));
  const listing = lines.flatMap(line => {
    const match = /^(\d+) (.+)$/.exec(line);
    return match ? [{ size: Number(match[1]), path: match[2] }] : [];
  });
  const files = listing.filter(file => /^app\/DATA\/[^/]+\.blb$/i.test(file.path));
  assert.deepEqual(files.map(file => path.basename(file.path).toLowerCase()).sort(), names.sort());
  assert.ok(files.every(file => file.size > 0 && file.size <= 512 * 1024 * 1024));
  assert.ok(files.reduce((sum, file) => sum + file.size, 0) <= 1024 * 1024 * 1024);
  module = null;
  lines = [];
  module = await instance(lines);
  module.FS.mkdir('/output');
  const started = Date.now();
  assert.equal(module.callMain(['--extract', ...common, '--output-dir=/output', ...files.map(file => `--include=/${file.path}`), `/input/${installer}`]), 0);
  function outputFiles(directory) {
    return module.FS.readdir(directory).filter(name => name !== '.' && name !== '..').flatMap(name => {
      const target = `${directory}/${name}`;
      return module.FS.isDir(module.FS.stat(target).mode) ? outputFiles(target) : [target];
    });
  }
  assert.deepEqual(outputFiles('/output').sort(), files.map(file => `/output/${file.path}`).sort());
  let total = 0;
  for (const file of files) {
    const target = `/output/${file.path}`;
    assert.equal(module.FS.stat(target).size, file.size);
    const stream = module.FS.open(target, 'r');
    const buffer = new Uint8Array(1024 * 1024);
    const hash = crypto.createHash('sha256');
    for (let offset = 0; offset < file.size;) {
      const count = module.FS.read(stream, buffer, 0, Math.min(buffer.length, file.size - offset), offset);
      assert.ok(count > 0);
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    module.FS.close(stream);
    const digest = hash.digest('hex');
    const referenceFile = fs.readdirSync(reference).find(name => name.toLowerCase() === path.basename(file.path).toLowerCase());
    assert.ok(referenceFile, `Reference missing: ${file.path}`);
    const expected = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(path.join(reference, referenceFile))) expected.update(chunk);
    assert.equal(digest, expected.digest('hex'), `Hash mismatch: ${file.path}`);
    console.log(`${file.size} ${file.path} sha256=${digest}`);
    module.FS.unlink(target);
    total += file.size;
  }
  console.log(`PASS: extracted and hash-verified ${files.length} BLBs (${total} bytes) in ${((Date.now() - started) / 1000).toFixed(1)}s; WORKERFS export available.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
