"""Bind the complete extracted Smacker corpus to decoded metadata for a 7B batch."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction
import json
from pathlib import Path
import re

import prepare


def inspect(entry, assets, run_id):
    identity = entry['sourceSHA256']
    if not re.fullmatch(r'[0-9a-f]{64}', identity) or entry['id'] != identity:
        raise ValueError('Invalid source identity')
    source = (assets / entry['relativeAssetPath']).resolve(strict=True)
    if not source.is_relative_to(assets) or source.is_symlink():
        raise ValueError('Source must remain in private assets')
    if source.stat().st_size != entry['sourceBytes'] or prepare.digest(source) != identity:
        raise ValueError('Source content differs from inventory: ' + identity)
    streams = prepare.probe(source)
    stream, width, height, frames, fps = prepare.video_info(streams)
    prepare.verify_timeline(source, stream, width, height, frames, fps)
    if stream['codec_name'] != 'smackvideo':
        raise ValueError('Unexpected original video codec')
    audio = []
    for item in streams:
        if item.get('codec_type') in ('audio', 'video') and Fraction(item.get('start_time', '0')) != 0:
            raise ValueError('Delayed source track: ' + identity)
        if item.get('codec_type') == 'audio':
            audio.append({key: item[key] for key in ('index', 'codec_name', 'channels', 'sample_rate')})
    return {'id': identity, 'sourceSHA256': identity, 'sourceBytes': entry['sourceBytes'],
            'sourceKey': f'sources/probes/{run_id}/originals/{identity}.smk',
            'width': width, 'height': height, 'frames': frames, 'fps': prepare.rational(fps),
            'catalogFrameCount': entry['frameCount'], 'ringFrame': entry['ringFrame'],
            'sourceFlags': entry['sourceFlags'], 'requestedHash': entry['requestedHash'],
            'resourceIds': entry['resourceIds'], 'audio': audio,
            'role': 'full-smacker-corpus-unclassified',
            'presentation': 'source-relative4x; retain original runtime ring/doubling/navigation mapping'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog', type=Path, default=prepare.PRIVATE_ROOT / 'inputs/video-candidates.json')
    parser.add_argument('--assets', type=Path, default=prepare.PRIVATE_ROOT.parent / 'private-assets')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--run-id', default='movie-7b-full-20261021')
    args = parser.parse_args()
    output = args.output.resolve()
    if not output.is_relative_to(prepare.PRIVATE_ROOT) or not re.fullmatch(r'movie-7b-full-[a-zA-Z0-9-]+', args.run_id):
        raise ValueError('Private output and safe run ID required')
    catalog = json.loads(args.catalog.read_text())
    if catalog['private'] is not True or len(catalog['videos']) != catalog['uniqueVideos']:
        raise ValueError('Incomplete or non-private video inventory')
    if len({video['id'] for video in catalog['videos']}) != len(catalog['videos']):
        raise ValueError('Duplicate video identities')
    with ThreadPoolExecutor(max_workers=4) as pool:
        videos = list(pool.map(lambda entry: inspect(entry, args.assets.resolve(), args.run_id), catalog['videos']))
    # Finish shorter originals first; every identity remains explicitly in the plan.
    videos.sort(key=lambda item: (item['frames'], item['id']))
    plan = {'version': 1, 'private': True, 'runId': args.run_id, 'modelVariant': '7b',
            'chunkCoreFrames': 49, 'contextFrames': 4, 'scale': 4,
            'catalogSHA256': prepare.digest(args.catalog), 'sourceBinding': catalog['sourceBinding'],
            'videoResources': catalog['videoResources'], 'uniqueVideos': len(videos),
            'totalDecodedFrames': sum(item['frames'] for item in videos), 'videos': videos,
            'approvedForRuntime': False}
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with output.open('x') as stream:
        output.chmod(0o600)
        json.dump(plan, stream, indent=2)
        stream.write('\n')
    print(json.dumps({'plan': str(output), 'sha256': prepare.digest(output), 'videos': len(videos),
                      'frames': plan['totalDecodedFrames'], 'bytes': sum(item['sourceBytes'] for item in videos)}))


if __name__ == '__main__':
    main()
