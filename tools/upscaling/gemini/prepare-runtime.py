#!/usr/bin/env python3
"""Verify selected local approvals; normalize to native 4x PNG only with --execute."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import sys

from PIL import Image, __version__ as PILLOW_VERSION, features


ROOT = Path(__file__).resolve().parents[3]
SHA256 = re.compile(r'[0-9a-f]{64}\Z')


def directory_fd(path):
    """Walk without following symlinks, including intermediate path components."""
    path = Path(os.path.abspath(path))
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def private_path(path, private):
    path = Path(path)
    if '..' in path.parts:
        raise ValueError('Parent traversal is forbidden')
    path = Path(os.path.abspath(path))
    if not path.is_relative_to(private) or path == private:
        raise ValueError('Path must be inside private-assets: ' + str(path))
    return path


def read_private(path, private):
    path = private_path(path, private)
    parent = directory_fd(path.parent)
    try:
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        with os.fdopen(fd, 'rb') as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise ValueError('Input must be a regular file')
            return stream.read()
    finally:
        os.close(parent)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def checked_image(meta, private):
    data = read_private(meta['path'], private)
    if digest(data) != meta.get('sha256'):
        raise ValueError('Image hash mismatch: ' + meta['path'])
    with Image.open(io.BytesIO(data)) as image:
        image.load()
        if image.format != 'PNG' or getattr(image, 'n_frames', 1) != 1:
            raise ValueError('Input must be a single-frame PNG')
        if list(image.size) != meta.get('dimensions'):
            raise ValueError('Image dimensions mismatch: ' + meta['path'])
        rgba = image.convert('RGBA')
        if rgba.getchannel('A').getextrema() != (255, 255):
            raise ValueError('Background PNG must be opaque: ' + meta['path'])
        return rgba.convert('RGB')


def write_exclusive(fd, name, data):
    file_fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                      0o600, dir_fd=fd)
    with os.fdopen(file_fd, 'wb') as stream:
        stream.write(data)


def prepare(selection_path, private, output=None, execute=False, allow_partial=False):
    private = Path(os.path.abspath(private))
    root_fd = directory_fd(private)
    os.close(root_fd)
    if execute and output is None:
        raise ValueError('--execute requires --output to a fresh private directory')
    if output is not None and not execute:
        raise ValueError('--output requires --execute; default report never writes')
    raw = read_private(selection_path, private)
    selection = json.loads(raw)
    if (selection.get('schemaVersion') != 1 or selection.get('private') is not True
            or selection.get('purpose') != 'offline-human-approved-release-selection'
            or not isinstance(selection.get('valid'), bool)):
        raise ValueError('Invalid private release selection')
    selected, unapproved, conflicts = [selection[key] for key in ('selected', 'unapproved', 'conflicts')]
    groups = selected + unapproved + conflicts
    sources = [item['sourceSha256'] for item in groups]
    if any(not isinstance(s, str) or not SHA256.fullmatch(s) for s in sources):
        raise ValueError('Invalid source hash')
    if len(set(sources)) != len(sources):
        raise ValueError('Duplicate or quarantined source in selection')
    expected = {'sourceCount': len(groups), 'selectedSources': len(selected),
                'unapprovedSources': len(unapproved), 'conflictedSources': len(conflicts)}
    if any(selection['summary'].get(k) != v for k, v in expected.items()):
        raise ValueError('Selection summary mismatch')
    partial = not selection['valid'] or bool(unapproved or conflicts)
    if execute and partial and not allow_partial:
        raise ValueError('Invalid/incomplete selection requires --allow-partial')

    software = {'library': 'Pillow', 'version': PILLOW_VERSION,
                'zlibVersion': features.version_codec('zlib')}
    report = {'schemaVersion': 1, 'private': True, 'purpose': 'offline-runtime-normalization',
              'executed': execute, 'partial': partial, 'selectionValid': selection['valid'],
              'selection': {'path': str(private_path(selection_path, private)), 'sha256': digest(raw),
                            'catalogManifestSha256': selection.get('catalogManifestSha256'),
                            'inputs': selection.get('inputs', [])},
              'summary': expected, 'artifacts': [],
              'policy': {'networkCalls': 0, 'inferenceCalls': 0, 'automaticApproval': False,
                         'originalBytesModified': False, 'publishQuarantined': False}}
    # Verify every selected path before creating any output, including duplicate-byte aliases.
    for item in sorted(selected, key=lambda row: row['sourceSha256']):
        source, approved = item['source'], item['output']
        key = item['sourceSha256']
        if (source['sha256'] != key or not SHA256.fullmatch(approved['sha256'])
                or item.get('artifactId') != key + ':' + approved['sha256']
                or not item.get('approvalEvidence') or not item.get('candidateIdentities')):
            raise ValueError('Missing or mismatched exact approval identity')
        if any(c.get('sourceSha256') != key or c.get('outputSha256') != approved['sha256']
               for c in item['candidateIdentities']):
            raise ValueError('Approval candidate hash mismatch')
        original = checked_image(source, private)
        candidate = checked_image(approved, private)
        for meta, paths in ((source, item.get('sourcePaths', [])),
                            (approved, item.get('outputPaths', []))):
            for path in sorted(set(paths) - {meta['path']}):
                checked_image({**meta, 'path': path}, private)
        aliases = item['aliases']
        identities = item['identities']
        if (not identities or any(i.get('sourceSha256') != key for i in identities)
                or sorted(set(aliases)) != sorted({a for i in identities for a in i['aliases']})
                or any(not i.get('sourceBinding') for i in identities)):
            raise ValueError('Missing or mismatched aliases/source bindings')
        target = [original.width * 4, original.height * 4]
        report['artifacts'].append({**item,
            'sourceBindings': [{'id': i['id'], 'roomId': i.get('roomId'),
                                'resourceId': i.get('resourceId'), 'aliases': i['aliases'],
                                'sourceBinding': i['sourceBinding'],
                                'additionalSources': i.get('additionalSources', [])} for i in identities],
            'runtime': {'path': key + '.png', 'sha256': None, 'dimensions': target,
                        'format': 'PNG', 'mode': 'RGB', 'opaque': True},
            'transform': {'operation': 'resize', 'resampler': 'Pillow.Image.Resampling.LANCZOS',
                          'fromDimensions': list(candidate.size), 'toDimensions': target,
                          'nativeScale': 4, 'crop': False, 'padding': False,
                          'encoding': 'lossless PNG', 'compressLevel': 9, 'optimize': False,
                          'software': software}})

    if execute:
        output = private_path(output, private)
        parent = directory_fd(output.parent)
        output_fd = None
        try:
            os.mkdir(output.name, mode=0o700, dir_fd=parent)
            output_fd = os.open(output.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            for item in report['artifacts']:
                # Read/hash/decode again to reject input changes after the preflight.
                checked_image(item['source'], private)
                candidate = checked_image(item['output'], private)
                resized = candidate.resize(tuple(item['runtime']['dimensions']), Image.Resampling.LANCZOS)
                encoded = io.BytesIO()
                resized.save(encoded, format='PNG', compress_level=9, optimize=False)
                data = encoded.getvalue()
                item['runtime']['sha256'] = digest(data)
                write_exclusive(output_fd, item['runtime']['path'], data)
            write_exclusive(output_fd, 'runtime-manifest.json',
                            (json.dumps(report, indent=2, ensure_ascii=True) + '\n').encode('utf-8'))
        finally:
            if output_fd is not None:
                os.close(output_fd)
            os.close(parent)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--selection', type=Path, default=ROOT / 'private-assets/upscaling/full-game-release/background-selection.json')
    parser.add_argument('--private-root', type=Path, default=ROOT / 'private-assets')
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--allow-partial', action='store_true')
    args = parser.parse_args()
    try:
        report = prepare(args.selection, args.private_root, args.output, args.execute, args.allow_partial)
        print(json.dumps(report, indent=2, ensure_ascii=True))
        return 0
    except (ValueError, KeyError, TypeError, OSError) as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
