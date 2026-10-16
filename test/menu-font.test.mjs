import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const directory = new URL('../web/assets/fonts/', import.meta.url);
const commit = '4e5f06dbb274a27ebe71ed54ea706b3ee40eabd9';
const expected = {
  'Mansalva-Regular.ttf': ['613ca294f0a364fd282a06d5e8a65db5d8f2bb8b834f8b21437a53cf70dafb8a', 'ebc942600613bbee91ec2134b2fbadaac4d93cc1', 355776],
  'OFL.txt': ['14ac0a5413a923c9ad11b6f541df17207fb7a0e0725e43eb29c88eb04c3ea2aa', 'db3eb9201fbd1b345526fa5e97ade64350d0cb32', 4391],
};

test('vendored menu font and full license match pinned official Google Fonts bytes', async () => {
  const provenance = JSON.parse(await readFile(new URL('provenance.json', directory), 'utf8'));
  assert.equal(provenance.name, 'Mansalva');
  assert.equal(provenance.version, '2.112');
  assert.equal(provenance.author, 'Carolina Short');
  assert.equal(provenance.authorURL, 'https://github.com/carolinashort/mansalva');
  assert.equal(provenance.license, 'OFL-1.1');
  assert.equal(provenance.modified, false);
  assert.equal(provenance.commit, commit);
  assert.equal(provenance.source, `https://github.com/google/fonts/tree/${commit}/ofl/mansalva`);
  assert.equal(provenance.metadataURL, `https://raw.githubusercontent.com/google/fonts/${commit}/ofl/mansalva/METADATA.pb`);
  assert.deepEqual(Object.keys(provenance.files).sort(), Object.keys(expected).sort());
  for (const [name, [sha256, gitBlob, length]] of Object.entries(expected)) {
    const bytes = await readFile(new URL(name, directory));
    assert.equal(bytes.length, length);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256);
    assert.equal(createHash('sha1').update(`blob ${length}\0`).update(bytes).digest('hex'), gitBlob);
    assert.deepEqual(provenance.files[name], {
      url: `https://raw.githubusercontent.com/google/fonts/${commit}/ofl/mansalva/${name}`,
      bytes: length,
      sha256,
      gitBlob,
    });
    if (name.endsWith('.ttf')) assert.equal(bytes.readUInt32BE(0), 0x00010000);
  }
  const license = await readFile(new URL('OFL.txt', directory), 'utf8');
  assert.ok(license.startsWith(`${provenance.licenseCopyright}\n`));
  assert.equal(provenance.licenseURL, provenance.files['OFL.txt'].url);
  assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1 - 26 February 2007/);
  assert.match(license, /OTHER DEALINGS IN THE FONT SOFTWARE\./);
  const notices = await readFile(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
  assert.ok(notices.includes(provenance.copyright));
  assert.ok(notices.includes(provenance.licenseCopyright));
  assert.ok(notices.includes('web/assets/fonts/OFL.txt'));
});
