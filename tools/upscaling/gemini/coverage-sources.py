#!/usr/bin/env python3
"""Freeze only the originals pictured on the explicitly authorized coverage page."""
import hashlib
import io
import json
import re
import stat
import subprocess
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
PAGE = ROOT / 'private-assets/upscaling/gemini-experiments/opaque-repair-v1/coverage-review.html'
REGISTRY = ROOT / 'private-assets/upscaling/opaque-repair-source-selection.json'
OUTPUT = ROOT / 'private-assets/upscaling/opaque-coverage-source-selection.json'
ARCHIVE = ROOT / 'private-assets/upscaling/opaque-coverage-sources/authorization-page.html'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def local_path(value, base, boundary):
    url = urlsplit(value)
    require(not (url.scheme or url.netloc or url.query or url.fragment), f'Not a local path: {value}')
    path = (base / unquote(url.path)).resolve()
    require(path.is_relative_to(boundary.resolve()), f'Path escapes allowed boundary: {value}')
    return path


class CoverageParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.articles = []
        self.current = None
        self.capture = None
        self.anchor = None

    def handle_starttag(self, tag, attrs):
        if tag == 'article':
            require(self.current is None, 'Nested article')
            self.current = {'headings': [], 'hashes': [], 'images': []}
        if self.current is None:
            require(tag != 'img', 'Image outside article is not covered')
            return
        names = [name for name, _ in attrs]
        require(len(names) == len(set(names)), f'Duplicate {tag} attributes')
        attrs = dict(attrs)
        if tag in ('h2', 'small'):
            require(self.capture is None, 'Nested heading/hash')
            self.capture = (tag, [])
        if tag == 'a':
            require(self.anchor is None, 'Nested image link')
            self.anchor = attrs.get('href')
        if tag == 'img':
            require(attrs.get('src') and self.anchor, 'Image needs src and original link')
            require(not attrs.get('srcset'), 'Ambiguous responsive image')
            self.current['images'].append({'src': attrs['src'], 'href': self.anchor})

    def handle_data(self, data):
        if self.capture:
            self.capture[1].append(data)

    def handle_endtag(self, tag):
        if self.current is None:
            return
        if self.capture and tag == self.capture[0]:
            key = 'headings' if tag == 'h2' else 'hashes'
            self.current[key].append(''.join(self.capture[1]).strip())
            self.capture = None
        if tag == 'a':
            self.anchor = None
        if tag == 'article':
            require(self.capture is None and self.anchor is None, 'Unclosed article content')
            self.articles.append(self.current)
            self.current = None


def parse_page(data, page, private, expected_count=39):
    parser = CoverageParser()
    parser.feed(data.decode('utf-8'))
    parser.close()
    require(parser.current is None, 'Unclosed article')
    require(len(parser.articles) == expected_count, f'Expected exactly {expected_count} articles')
    originals = []
    for index, article in enumerate(parser.articles):
        require(all(len(article[k]) == 1 for k in ('headings', 'hashes', 'images')), 'Article needs exactly one heading, SHA and image')
        heading = re.fullmatch(r'(Scene1402|HallOfRecordsScene)\s*/\s*(0x[0-9a-fA-F]{8})', article['headings'][0])
        digest = re.fullmatch(r'SHA-256:\s*([0-9a-f]{64})', article['hashes'][0])
        require(heading and digest, 'Invalid scene/resource or full SHA-256')
        image = article['images'][0]
        path = local_path(image['src'], page.parent, private)
        require(path == local_path(image['href'], page.parent, private), 'Thumbnail/original link mismatch')
        require(path.suffix.lower() == '.png', 'Original must be PNG')
        originals.append({'article': index + 1, 'scene': heading[1], 'resourceId': '0x' + heading[2][2:].upper(),
                          'src': image['src'], 'href': image['href'], 'path': str(path), 'sha256': digest[1]})
    require(len({o['sha256'] for o in originals}) == len(originals), 'Repeated picture SHA: do not silently skip articles')
    return originals


def inspect_png(path, digest):
    data = path.read_bytes()
    require(sha(data) == digest, f'PNG SHA mismatch: {path}')
    with Image.open(io.BytesIO(data)) as image:
        require(image.format == 'PNG', f'Not PNG: {path}')
        image.verify()
    with Image.open(io.BytesIO(data)) as image:
        image.load()
        require(image.convert('RGBA').getchannel('A').getextrema() == (255, 255), f'Nonopaque PNG: {path}')
        return {'path': str(path), 'role': 'source-composition', 'sha256': digest, 'bytes': len(data),
                'mimeType': 'image/png', 'dimensions': list(image.size)}, sha(image.convert('RGB').tobytes())


# Only orchestration here: existing bitmap decoder and engine palette resolver do all binary decoding.
DECODE = r"""
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {bitmap, png} from './tools/assets/formats.mjs';
import {bindPalette} from './tools/upscaling/gemini/repair-sources.mjs';
const hash = b => createHash('sha256').update(b).digest('hex');
const items = JSON.parse(fs.readFileSync(0, 'utf8'));
for (const p of items) {
  const d = bitmap(fs.readFileSync(p.original.payload.path));
  assert.deepEqual(d.pixels, fs.readFileSync(p.original.indexedPixels.path));
  assert.deepEqual(d.palette, fs.readFileSync(p.original.palette.path));
  assert.deepEqual([d.width,d.height], p.alias.dimensions);
  assert.equal(p.alias.operations.length, p.alias.paletteProofs.length);
  const palette = bindPalette(d.palette, p.alias.operations, key => {
    const matches = p.alias.paletteProofs.filter(x => typeof key === 'number' ? Number(x.requestedHash) === key : x.requested === key);
    assert(matches.length > 0);
    assert(matches.every(x => x.palette.sha256 === matches[0].palette.sha256));
    return fs.readFileSync(matches[0].palette.path);
  });
  assert.equal(hash(palette), p.alias.boundPaletteSha256);
  assert.equal(hash(png(d.pixels,d.width,d.height,palette)), p.alias.sourceSha256);
}
console.log(JSON.stringify({verifiedBindings:items.length}));
"""


def prepare(root=ROOT, page=PAGE, registry_path=REGISTRY, output=OUTPUT, archive=ARCHIVE):
    root, page = root.resolve(), page.resolve()
    private = (root / 'private-assets').resolve()
    require(page.is_relative_to(private), 'Authorization page must be private')
    for target in (registry_path, output, archive):
        require(target.resolve().is_relative_to(private), 'Output/registry must remain private')
    page_bytes, registry_bytes = page.read_bytes(), registry_path.read_bytes()
    originals = parse_page(page_bytes, page, private)
    require(sum(o['scene'] == 'Scene1402' for o in originals) == 1, 'Expected one Scene1402')
    require(sum(o['scene'] == 'HallOfRecordsScene' for o in originals) == 38, 'Expected 38 HallOfRecords RGB states')
    registry = json.loads(registry_bytes)
    verified = {o['catalogResourceId']: o for o in registry['verifiedOriginals']}
    checked = {}

    def evidence(value):
        if isinstance(value, list):
            return [evidence(v) for v in value]
        if not isinstance(value, dict):
            return value
        result = {k: evidence(v) for k, v in value.items()}
        if 'path' in result:
            path = local_path(result['path'], root, root)
            require(re.fullmatch('[0-9a-f]{64}', result.get('sha256', '')) is not None, f'Missing evidence SHA: {path}')
            if str(path) not in checked:
                checked[str(path)] = path.read_bytes()
            data = checked[str(path)]
            require(sha(data) == result['sha256'], f'Evidence SHA mismatch: {path}')
            if 'bytes' in result:
                require(len(data) == result['bytes'], f'Evidence size mismatch: {path}')
            result['path'] = str(path)
        return result

    rooms, replay = [], []
    for pictured in originals:
        source, rgb = inspect_png(Path(pictured['path']), pictured['sha256'])
        dims = [640, 500] if pictured['scene'] == 'Scene1402' else [640, 480]
        require(source['dimensions'] == dims, 'Unexpected native dimensions')
        aliases = [d for d in registry['dispositions']
                   if d.get('sourcePath') and local_path(d['sourcePath'], root, private) == Path(pictured['path'])
                   and d.get('sourceSha256') == pictured['sha256']]
        require(aliases, f'No exact path/SHA provenance for article {pictured["article"]}')
        require(any(d['scene'] == pictured['scene'] and d['resourceId'] == pictured['resourceId'] for d in aliases), 'Pictured heading not bound')
        proofs = []
        for alias in aliases:
            require(alias['rgbPixelSha256'] == rgb and alias['dimensions'] == dims, 'RGB/dimensions provenance mismatch')
            require(alias['catalogResourceId'] in verified, 'Missing original indexed bitmap proof')
            original = evidence(verified[alias['catalogResourceId']])
            bound = evidence(alias)
            bound['sourcePath'] = pictured['path']
            require(original.get('indexedPixels') and original.get('palette') and bound.get('codeBinding'), 'Incomplete bitmap/palette/engine proof')
            proofs.append({'original': original, 'alias': bound})
            replay.append(proofs[-1])
        primary = next(p for p in proofs if p['alias']['scene'] == pictured['scene'] and p['alias']['resourceId'] == pictured['resourceId'])
        room_id = f'{pictured["scene"]}-{pictured["resourceId"][2:]}-{rgb[:8]}'
        provenance = {**primary['original'], 'codeBinding': primary['alias']['codeBinding'],
                      'paletteProofs': primary['alias']['paletteProofs'], 'boundPaletteSha256': primary['alias']['boundPaletteSha256'],
                      'bindingOriginals': proofs, 'decoding': {'existingDecoder': 'tools/assets/formats.mjs:bitmap,png',
                      'paletteResolver': 'tools/upscaling/gemini/repair-sources.mjs:bindPalette',
                      'opaque': True, 'cropped': False, 'resampled': False, 'transforms': []}}
        for key in ('tableBinding', 'factoryBinding', 'state'):
            if key in primary['alias']:
                provenance[key] = primary['alias'][key]
        rooms.append({'id': room_id, 'labelRussian': '\u0421\u0446\u0435\u043d\u0430 1402' if pictured['scene'] == 'Scene1402' else '\u0417\u0430\u043b \u043b\u0435\u0442\u043e\u043f\u0438\u0441\u0435\u0439 / ' + pictured['resourceId'],
                      'resourceId': pictured['resourceId'], 'sourcePath': pictured['path'], 'source': source,
                      'rgbPixelSha256': rgb, 'provenance': provenance, 'bindingAliases': [p['alias'] for p in proofs]})
    require(len({r['rgbPixelSha256'] for r in rooms}) == 39, 'Gallery RGBs not unique: stop rather than skip pictures')
    result = subprocess.run(['node', '--input-type=module', '-e', DECODE], cwd=root, input=json.dumps(replay), text=True, capture_output=True)
    require(result.returncode == 0, f'Original decoder/palette replay failed: {result.stderr}')
    replay_result = json.loads(result.stdout)
    require(replay_result['verifiedBindings'] == len(replay), 'Incomplete decoder replay')
    document = {'schemaVersion': 1, 'purpose': 'explicitly-authorized-coverage-page-originals-only', 'private': True,
                'authorizationTime': '2026-10-21T11:23:15Z', 'generationCalls': 0, 'networkCalls': 0,
                'authorizationPage': {'path': str(page), 'sha256': sha(page_bytes), 'bytes': len(page_bytes),
                                      'archivePath': str(archive.resolve()), 'orderedOriginals': originals},
                'priorRegistry': {'path': str(registry_path.resolve()), 'sha256': sha(registry_bytes), 'bytes': len(registry_bytes)},
                'statistics': {'picturedOriginals': 39, 'scene1402': 1, 'hallOfRecordsRgbStates': 38,
                               'hallOfRecordsUniqueBitmapResources': len({r['provenance']['catalogResourceId'] for r in rooms[1:]}),
                               'verifiedBindingAliases': len(replay)},
                'limitations': ['Original base bitmaps only, not runtime layer assembly.',
                                'Only pictured originals authorized; no omitted runtime black-fill endpoints.',
                                'Native 640x500 retained without cropping; no generated inputs or source pixel transformations.'],
                'rooms': rooms}
    frozen = (json.dumps(document, indent=2, ensure_ascii=True) + '\n').encode()
    # Validate every existing frozen artifact before writing either missing artifact.
    for target, data in ((archive, page_bytes), (output, frozen)):
        if target.exists():
            require(target.read_bytes() == data, f'Frozen artifact changed; refusing regeneration: {target}')
            require(stat.S_IMODE(target.stat().st_mode) == 0o444, f'Frozen artifact not mode 444: {target}')
    require(page.read_bytes() == page_bytes and registry_path.read_bytes() == registry_bytes, 'Inputs changed during preparation')
    archive.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    for target, data in ((archive, page_bytes), (output, frozen)):
        if not target.exists():
            with target.open('xb') as stream:
                stream.write(data)
            target.chmod(0o444)
    return document


if __name__ == '__main__':
    try:
        require(len(sys.argv) == 1, 'No options: offline prepare/verify only')
        manifest = prepare()
        print(json.dumps({'path': str(OUTPUT), 'sha256': sha(OUTPUT.read_bytes()),
                          'authorizationPageSha256': manifest['authorizationPage']['sha256'], **manifest['statistics']}))
    except (ValueError, OSError, KeyError) as error:
        print(f'Coverage source preparation stopped: {error}', file=sys.stderr)
        sys.exit(1)
