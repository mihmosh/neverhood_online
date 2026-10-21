# SPDX-License-Identifier: GPL-3.0-or-later
"""Package Blender cursor renders. Run after build_cursors.py with Pillow."""
import argparse
import hashlib
import json
import zipfile
from pathlib import Path

from PIL import Image, ImageDraw

from common import DEFAULT_OUTPUT, output_directory


def package(output):
    output = output_directory(output)
    manifest = json.loads((output / 'build.json').read_text())
    atlas = Image.new('RGBA', (384, 896))
    contact = Image.new('RGB', (640, 7*160), '#302b29')
    draw = ImageDraw.Draw(contact)
    frames = []
    previews = [Image.new('RGBA', (128, 896)) for _ in range(3)]
    for record in manifest['rows']:
        row, name = record['row'], record['name']
        folder = output / 'sprites' / f'r{row}-{name}'
        poses = []
        draw.text((12, row*160+12), f'r{row} {name}', fill='#f1d5c0')
        draw.text((12, row*160+32), f"hotspot {record['hotspot']}", fill='#c0aaa0')
        for ordinal in range(3):
            master = folder / f'f{ordinal}-clay-1024.png'
            with Image.open(master) as image:
                if image.size != (1024, 1024) or image.mode != 'RGBA':
                    raise ValueError(f'Invalid master: {master}')
                image = image.convert('RGBA')
                image.getchannel('A').save(folder / f'f{ordinal}-alpha-1024.png')
                sprite = image.convert('RGBa').resize((128, 128), Image.Resampling.LANCZOS).convert('RGBA')
            bbox = sprite.getchannel('A').point(lambda a: 255 if a >= 128 else 0).getbbox()
            if not bbox or bbox[0] == 0 or bbox[1] == 0 or bbox[2] == 128 or bbox[3] == 128:
                raise ValueError(f'Empty or clipped silhouette: row {row}, frame {ordinal}, {bbox}')
            target = folder / f'f{ordinal}-clay-128.png'
            sprite.save(target)
            atlas.alpha_composite(sprite, (ordinal*128, row*128))
            previews[ordinal].alpha_composite(sprite, (0, row*128))
            contact.paste(sprite, (200+ordinal*144, row*160+16), sprite)
            frames.append(dict(row=row, ordinal=ordinal, image=str(target.relative_to(output)),
                               master=str(master.relative_to(output)),
                               atlasRect=[ordinal*128, row*128, 128, 128], alphaBBox=list(bbox),
                               sha256=hashlib.sha256(target.read_bytes()).hexdigest()))
            poses.append(sprite)
        poses[0].save(folder/'animation.webp', save_all=True, append_images=poses[1:], duration=82, loop=0, lossless=True)
    atlas.save(output / 'sprite-sheet-128.png')
    contact.save(output / 'contact-sheet.png')
    previews[0].save(output/'all-cursors.webp', save_all=True, append_images=previews[1:], duration=82, loop=0, lossless=True)
    manifest.update(frames=frames, image='sprite-sheet-128.png', atlasSize=[384, 896],
                    alpha='Straight RGBA; premultiplied-alpha Lanczos downsampling',
                    mediaRights=dict(status='not-evaluated',
                        notice='The software license does not grant rights to input models, shape recipes or generated media. Review rights before redistribution.'),
                    runtimeIntegration='Standalone pack; existing game bindings unchanged')
    (output/'cursor.json').write_text(json.dumps(manifest, indent=2)+'\n')
    # Package only known deliverables, never arbitrary local files or checkpoints.
    files = [output/name for name in ('hd-cursor.blend', 'build.json', 'cursor.json',
             'sprite-sheet-128.png', 'contact-sheet.png', 'all-cursors.webp')]
    for record in manifest['rows']:
        folder = output / 'sprites' / f"r{record['row']}-{record['name']}"
        files.append(folder/'animation.webp')
        files.extend(folder/f'f{i}-{kind}-{size}.png' for i in range(3)
                     for kind, size in [('clay', 1024), ('alpha', 1024), ('clay', 128)])
    files.sort()
    (output/'SHA256SUMS').write_text(''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.relative_to(output)}\n' for p in files))
    archive = output.with_suffix('.zip')
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
        for path in [*files, output/'SHA256SUMS']:
            bundle.write(path, Path('hd-cursor')/path.relative_to(output))
    print(json.dumps(dict(output=str(output), archive=str(archive), frames=len(frames)), indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=DEFAULT_OUTPUT)
    package(parser.parse_args().output)
