import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const commit = '4e5f06dbb274a27ebe71ed54ea706b3ee40eabd9';
const source = `https://github.com/google/fonts/tree/${commit}/ofl/mansalva`;
const raw = `https://raw.githubusercontent.com/google/fonts/${commit}/ofl/mansalva`;
const destination = new URL('../web/assets/fonts/', import.meta.url);
const maxBytes = 5 * 1024 * 1024;
const provenance = {
  name: 'Mansalva',
  version: '2.112',
  author: 'Carolina Short',
  authorURL: 'https://github.com/carolinashort/mansalva',
  copyright: 'Copyright 2022 The Mansalva Project Authors (https://github.com/carolinashort/mansalva)',
  licenseCopyright: 'Copyright 2019 The Mansalva Project Authors (https://github.com/carolinashort/mansalva)',
  license: 'OFL-1.1',
  licenseURL: `${raw}/OFL.txt`,
  source,
  metadataURL: `${raw}/METADATA.pb`,
  commit,
  modified: false,
  files: {
    'Mansalva-Regular.ttf': {
      url: `${raw}/Mansalva-Regular.ttf`,
      bytes: 355776,
      sha256: '613ca294f0a364fd282a06d5e8a65db5d8f2bb8b834f8b21437a53cf70dafb8a',
      gitBlob: 'ebc942600613bbee91ec2134b2fbadaac4d93cc1',
    },
    'OFL.txt': {
      url: `${raw}/OFL.txt`,
      bytes: 4391,
      sha256: '14ac0a5413a923c9ad11b6f541df17207fb7a0e0725e43eb29c88eb04c3ea2aa',
      gitBlob: 'db3eb9201fbd1b345526fa5e97ade64350d0cb32',
    },
  },
};

async function download(name, file) {
  const response = await fetch(file.url, {
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  });
  if (!response.ok || !response.body) throw new Error(`${name}: HTTP ${response.status}`);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > maxBytes) throw new Error(`${name}: exceeds 5 MiB download limit`);
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, length);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const gitBlob = createHash('sha1').update(`blob ${length}\0`).update(bytes).digest('hex');
  if (length !== file.bytes || sha256 !== file.sha256 || gitBlob !== file.gitBlob) {
    throw new Error(`${name}: pinned source integrity mismatch`);
  }
  return [name, bytes];
}

// Verify both immutable upstream files before replacing any local asset.
const downloads = await Promise.all(Object.entries(provenance.files).map(([name, file]) => download(name, file)));
await mkdir(destination, { recursive: true });
for (const [name, bytes] of downloads) await writeFile(new URL(name, destination), bytes);
await writeFile(new URL('provenance.json', destination), `${JSON.stringify(provenance, null, 2)}\n`);
console.log(`Vendored unmodified Mansalva ${provenance.version} from Google Fonts ${commit}`);
