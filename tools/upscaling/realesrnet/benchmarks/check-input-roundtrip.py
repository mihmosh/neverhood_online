"""Locate ghosting before/after video encoding without running a model."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

import numpy as np
from PIL import Image, ImageDraw

parser = argparse.ArgumentParser()
parser.add_argument('--input-dir', type=Path, required=True)
parser.add_argument('--model-frame', type=Path, required=True)
parser.add_argument('--clip-frame', type=int, default=8)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
source = args.input_dir.resolve()
metadata = json.loads((source / 'source-metadata.json').read_text())
width, height = metadata['canvas']
timeline = metadata['timeline']
frame = args.clip_frame
if not 0 <= frame < len(timeline) - 1:
    raise ValueError('Choose a frame with a following input frame')
video = source / 'input.mp4'
if hashlib.sha256(video.read_bytes()).hexdigest() != metadata['videos']['input.mp4']['sha256']:
    raise ValueError('Input video changed after preparation')
raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(video), '-map', '0:v:0',
                               '-vsync', '0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])
if len(raw) != len(timeline) * width * height * 3:
    raise ValueError('Decoded frame count differs from the prepared timeline')
decoded = np.frombuffer(raw, dtype=np.uint8).reshape(len(timeline), height, width, 3)
per_frame = []
for index, item in enumerate(timeline):
    record = metadata['sourceFrames'][item['sourceOrdinal']]
    rgba = Image.open(source / record['alignedRGBA']).convert('RGBA')
    prepared = Image.open(source / item['rgbFile']).convert('RGB')
    expected = Image.new('RGB', rgba.size, (128, 128, 128))
    expected.paste(rgba.convert('RGB'), mask=rgba.getchannel('A'))
    if not np.array_equal(np.asarray(expected), np.asarray(prepared)):
        raise ValueError(f'RGB preparation differs from the original masked frame: {index}')
    delta = np.abs(decoded[index].astype(np.int16) - np.asarray(prepared).astype(np.int16))
    per_frame.append({'clipFrame': index, 'sourceOrdinal': item['sourceOrdinal'],
                      'rgbToVideoMAE': float(delta.mean()), 'rgbToVideoMaxDelta': int(delta.max())})
model = Image.open(args.model_frame).convert('RGB')
scale = model.width // width
if scale < 1 or model.size != (width * scale, height * scale):
    raise ValueError('Model frame must be an exact integer scale for this diagnostic')
def mask(index):
    record = metadata['sourceFrames'][timeline[index]['sourceOrdinal']]
    return np.asarray(Image.open(source / record['mask']).resize(model.size, Image.Resampling.NEAREST)) > 0
current, following = mask(frame), mask(frame + 1)
next_only = following & ~current
input_scaled = np.asarray(Image.fromarray(decoded[frame]).resize(model.size, Image.Resampling.NEAREST))
model_rgb = np.asarray(model)
hold_end = metadata['holdsBefore'] + 1
hold_delta = np.abs(decoded[1:hold_end].astype(np.int16) - decoded[:hold_end - 1].astype(np.int16))
report = {'inputVideoSHA256Verified': True, 'framesChecked': len(timeline),
          'preparedRgbMatchesOriginalMaskedFrame': True,
          'maximumRoundtripChannelDelta': max(item['rgbToVideoMaxDelta'] for item in per_frame),
          'meanRoundtripMAE': float(np.mean([item['rgbToVideoMAE'] for item in per_frame])),
          'firstHeldPoseDecodedMaxDelta': int(hold_delta.max()),
          'frame': per_frame[frame], 'nextFrame': per_frame[frame + 1],
          'nextPoseOutsideCurrentMask': {'pixels': int(next_only.sum()),
              'inputMeanDistanceFromGray': float(np.abs(input_scaled.astype(np.int16) - 128)[next_only].mean()),
              'modelMeanDistanceFromGray': float(np.abs(model_rgb.astype(np.int16) - 128)[next_only].mean())},
          'scope': 'Localizes artifact to before/after restoration; does not distinguish DiT, temporal VAE, or runner batching.'}
output = args.output.resolve()
output.mkdir(parents=True, exist_ok=True)
(output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
tiles = [Image.fromarray(decoded[frame]).resize(model.size, Image.Resampling.NEAREST),
         model, Image.fromarray(decoded[frame + 1]).resize(model.size, Image.Resampling.NEAREST)]
labels = [f'Decoded input {frame}: source {timeline[frame]["sourceOrdinal"]}',
          f'Raw restored PNG {frame}', f'Decoded input {frame + 1}: source {timeline[frame + 1]["sourceOrdinal"]}']
tile_size = (768, 432)
sheet = Image.new('RGB', (tile_size[0] * 3, tile_size[1] + 30), '#202020')
draw = ImageDraw.Draw(sheet)
for index, (image, label) in enumerate(zip(tiles, labels)):
    sheet.paste(image.resize(tile_size, Image.Resampling.LANCZOS), (index * tile_size[0], 30))
    draw.text((index * tile_size[0] + 8, 8), label, fill='white')
sheet.save(output / 'input-model-next.png')
print(json.dumps(report, indent=2))
