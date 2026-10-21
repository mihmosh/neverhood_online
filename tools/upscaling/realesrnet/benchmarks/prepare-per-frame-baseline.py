"""Verify cached RealESRNet frames and align a fair RGB baseline without inference."""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument('--input-dir', type=Path, required=True)
parser.add_argument('--sequence-dir', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
source = args.input_dir.resolve()
cache = args.sequence_dir.resolve()
output = args.output.resolve()
repo = Path(__file__).resolve().parents[4]
if output.is_relative_to(repo) and not output.is_relative_to(repo / 'private-assets'):
    raise SystemExit('Generated frames must remain outside source/public directories')
if output.exists():
    raise SystemExit('Output must be new')
sha = lambda data: hashlib.sha256(data).hexdigest()
metadata = json.loads((source / 'source-metadata.json').read_text())
sequence = json.loads((cache / 'sequence.json').read_text())
run = json.loads((cache.parent / 'manifest.json').read_text())
checkpoint = 'a820b9bde89a874d7599d545567308ce6c128fc8754a53208eda016d40aa81df'
if run['model']['name'] != 'RealESRNet_x4plus' or run['model']['sha256'] != checkpoint:
    raise SystemExit('Not the current RealESRNet checkpoint')
if run['inputManifestSHA256'] != metadata['sourceManifestSHA256'] or len(sequence['frames']) != metadata['sourceFrameCount']:
    raise SystemExit('Cached baseline uses a different source manifest/sequence')
width, height = [value * 4 for value in metadata['canvas']]
output.mkdir(parents=True)
(output / 'frames').mkdir()
(output / 'legacy-alpha-samples').mkdir()
aligned, source_records = [], []
for index, (frame, original) in enumerate(zip(sequence['frames'], metadata['sourceFrames'])):
    if frame['index'] != original['sourceOrdinal'] or frame['frameId'] != original['sourceFrameId'] or frame['sha256'] != original['sourceSHA256'] or frame['metadata'] != original['metadata']:
        raise SystemExit(f'Source identity mismatch: {index}')
    path = cache / frame['neuralFile']
    data = path.read_bytes()
    if sha(data) != frame['neuralSHA256']:
        raise SystemExit(f'Cached neural output hash mismatch: {index}')
    image = Image.open(path)
    image.load()
    if image.mode != 'RGBA' or image.size != tuple(value * 4 for value in frame['size']):
        raise SystemExit('Cached output has wrong format/dimensions')
    mask_data = (source / original['mask']).read_bytes()
    if sha(mask_data) != original['maskSHA256']:
        raise SystemExit('Source mask changed')
    mask = Image.open(source / original['mask']).resize((width, height), Image.Resampling.NEAREST)
    if set(np.unique(np.asarray(mask))) - {0, 255}:
        raise SystemExit('Non-binary authoritative mask')
    x, y = [value * 4 for value in original['canvasXY']]
    if x < 0 or y < 0 or x + image.width > width or y + image.height > height:
        raise SystemExit('Cached sprite would be cropped')
    gray = Image.new('RGB', (width, height), (128, 128, 128))
    rgb = gray.copy()
    rgb.paste(image.convert('RGB'), (x, y))
    rgb = Image.composite(rgb, gray, mask)
    aligned.append(rgb)
    if index in (0, 8, 16, 24, 31):
        legacy = gray.copy()
        legacy.paste(image.convert('RGB'), (x, y), image.getchannel('A'))
        legacy.save(output / f'legacy-alpha-samples/{index:04d}.png')
    source_records.append({'sourceOrdinal': index, 'sourceFrameId': frame['frameId'], 'sourceSHA256': frame['sha256'],
                           'cacheFile': str(path), 'cacheSHA256': frame['neuralSHA256'], 'sourceMaskSHA256': original['maskSHA256'],
                           'hdPlacement': [x, y], 'hdSize': list(image.size), 'crop': None, 'flip': False})
frames = []
for item in metadata['timeline']:
    file = f'frames/input_{item["clipFrame"]:06d}.png'
    aligned[item['sourceOrdinal']].save(output / file)
    data = (output / file).read_bytes()
    frames.append({'clipFrame': item['clipFrame'], 'sourceOrdinal': item['sourceOrdinal'], 'file': file,
                   'bytes': len(data), 'sha256': sha(data)})
record = {'version': 1, 'model': 'RealESRNet_x4plus', 'modelProvenance': run['model'],
          'inputSHA256': metadata['videos']['input.mp4']['sha256'], 'sourceManifestSHA256': metadata['sourceManifestSHA256'],
          'sourceFrames': source_records, 'canvas': [width, height], 'frames': frames, 'sourceFrameCount': len(aligned),
          'fps': metadata['fps'], 'storage': 'Verified lossless 8-bit RGBA cache, normalized RGB PNGs; no WebP compression',
          'alphaPolicy': 'Main baseline uses shared original NEAREST4x binary mask; historical neural alpha is excluded from method comparison',
          'rawComposition': 'Per-frame RGB has no surrounding video context and is placed over gray using the original mask; unlike Seed raw, no whole-canvas prediction outside the silhouette',
          'legacyAlphaSamples': 'Separate samples preserve historical neural alpha for reference, not used for the shared-mask comparison',
          'runtimePackByteIdentity': False, 'runtimePackCaveat': 'Exact probe palette, same current room-method checkpoint; not a byte-for-byte runtime room pack or its WebP Q90 encoding',
          'inferenceRunNow': False, 'inferenceSeconds': None}
(output / 'metadata.json').write_text(json.dumps(record, indent=2) + '\n')
print(json.dumps({'model': record['model'], 'sourceFrames': len(aligned), 'processingFrames': len(frames),
                  'canvas': record['canvas'], 'losslessCacheVerified': True, 'inferenceRunNow': False, 'output': str(output)}))
