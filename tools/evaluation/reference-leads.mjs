import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../private-research');
const marker = JSON.parse(await readFile(path.join(root, '.private-research-no-public'), 'utf8'));
if (!marker.private) throw new Error('Reference research must remain private.');
const url = 'https://archive.org/metadata/1-133_202405';
const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
if (!response.ok) throw new Error(`Archive metadata: HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
if (bytes.length > 5 * 1024 ** 2) throw new Error('Reference metadata is unexpectedly large.');
const metadata = JSON.parse(bytes.toString('utf8'));
const sha256 = createHash('sha256').update(bytes).digest('hex');
const destination = path.join(root, 'reference-leads');
await mkdir(destination, { recursive: true, mode: 0o700 });
const file = `archive-org-collection-${sha256}.json`;
await writeFile(path.join(destination, file), bytes, { mode: 0o600 });
const manifest = { version: 1, private: true, downloaded: [{ url, file, bytes: bytes.length, sha256, retrievedAt: new Date().toISOString() }],
  findings: { title: metadata.metadata?.title, collectionAdded: metadata.metadata?.addeddate, jpgEntries: metadata.files?.filter(file => /\.jpe?g$/i.test(file.name)).length,
    archiveDeclaredOriginalJpegs: metadata.files?.filter(file => file.source === 'original' && /\.jpe?g$/i.test(file.name)).length,
    provenanceNote: 'Archive-declared original means an uploaded file, not proof of original camera photography.',
    status: 'public scan-collection metadata, not authenticated original camera footage', imageFilesDownloaded: false, reuseRightsVerified: false },
  unresolved: ['Original Uncompressed Footage of The Neverhood: original post URL/date, camera origin, actual quality and reuse permission remain unverified.'],
};
await writeFile(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(manifest, null, 2));
