#!/usr/bin/env python3
"""Select exact human-approved local artifacts offline; report only unless --output is supplied."""
import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import sys
from urllib.parse import unquote, urlsplit

from PIL import Image


ROOT = Path(__file__).resolve().parents[3]


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def identity(row):
    return {'id': row['id'], 'candidateId': row['candidateId'],
            'sourceSha256': (row.get('source') or {}).get('sha256'),
            'outputSha256': (row.get('output') or {}).get('sha256')}


def pair(item):
    return item.get('sourceSha256'), item.get('outputSha256')


def build_selection(catalog_path, export_path, receipt_path, private):
    private = Path(private).resolve()
    catalog_path, export_path, receipt_path = map(Path, (catalog_path, export_path, receipt_path))
    catalog, export, receipt = [json.loads(p.read_text(encoding='utf-8'))
                                for p in (catalog_path, export_path, receipt_path)]
    if catalog.get('schemaVersion') != 2 or catalog.get('private') is not True:
        raise ValueError('Invalid private catalog')
    if export.get('schemaVersion') != 2 or export.get('manifestSha256') not in {
            catalog['manifestSha256'], catalog.get('previousCatalogManifestSha256')}:
        raise ValueError('Stale export manifest')
    if not export.get('manifestSha256'):
        raise ValueError('Missing export manifest')
    rows = catalog['rooms']
    by_id = {row['id']: row for row in rows}
    if len(by_id) != len(rows):
        raise ValueError('Duplicate catalog identity')
    declared = {item['id']: item for item in export['candidates']}
    decisions = {item['id']: item for item in export['decisions']}
    if (len(declared) != len(export['candidates']) or len(decisions) != len(export['decisions'])
            or set(declared) != set(decisions)):
        raise ValueError('Duplicate or incomplete export identities')
    if export['manifestSha256'] == catalog['manifestSha256'] and set(declared) != set(by_id):
        raise ValueError('Incomplete current-manifest export')
    states, approvals = {}, {}
    artifacts = {}
    for row in rows:
        key = pair(identity(row))
        if key[0] and key[1]:
            artifacts.setdefault(key, []).append(row)
    for key, item in decisions.items():
        row = by_id.get(key)
        if (not row or declared[key] != identity(row)
                or any(item.get(k) != v for k, v in identity(row).items())):
            raise ValueError('Stale or mismatched export identity: ' + key)
        state = item.get('decision')
        if state not in ('pending', 'approved', 'rework') or not isinstance(item.get('notes'), str):
            raise ValueError('Invalid exported decision')
        artifact = pair(item)
        if artifact in states and states[artifact] != state:
            raise ValueError('Conflicting exact artifact decisions')
        states[artifact] = state
        if state == 'approved':
            if not row.get('canApprove') or not row.get('available') or not all(artifact):
                raise ValueError('Unapprovable exported artifact')
            approvals.setdefault(artifact, []).append({'kind': 'manual-review-export', 'id': key,
                                                      'manifestSha256': export['manifestSha256']})
    if (receipt.get('schemaVersion') != 1 or receipt.get('reviewer') != 'user'
            or not receipt.get('receiptId') or not isinstance(receipt.get('decisions'), list)):
        raise ValueError('Invalid human approval receipt')
    seen = set()
    for item in receipt['decisions']:
        artifact = pair(item)
        matches = artifacts.get(artifact, [])
        if (artifact in seen or not all(artifact) or not matches or item.get('decision') != 'approved'
                or not all(r.get('canApprove') and r.get('available') for r in matches)):
            raise ValueError('Stale, duplicate or unapprovable receipt artifact')
        if states.get(artifact) == 'rework':
            raise ValueError('Receipt conflicts with exact artifact rework decision')
        seen.add(artifact)
        states[artifact] = 'approved'
        approvals.setdefault(artifact, []).append({'kind': 'human-receipt', 'receiptId': receipt['receiptId']})

    # Supersession is explicit receipt evidence, never an inference from timestamps.
    superseded = {}
    for rule in receipt.get('supersessions', []):
        source = rule.get('sourceSha256')
        old = (source, rule.get('oldOutputSha256'))
        new = (source, rule.get('newOutputSha256'))
        if (old == new or old not in approvals or new not in approvals or old in superseded
                or not isinstance(rule.get('justification'), str) or not rule['justification'].strip()):
            raise ValueError('Invalid exact supersession evidence')
        newer = artifacts[new]
        try:
            times = {r['id']: datetime.fromisoformat(r['startedAt'].replace('Z', '+00:00'))
                     for r in rows if (r.get('source') or {}).get('sha256') == source
                     and r.get('output') and r.get('available')}
            latest = max(times.values())
            if not all(times[r['id']] == latest and times[r['id']] > max(times[o['id']] for o in artifacts[old])
                       and 'rework' in r.get('provenance', {}).get('experimentId', '').lower()
                       for r in newer):
                raise ValueError('Supersession must name the exact latest rework')
        except (KeyError, TypeError) as error:
            raise ValueError('Missing latest rework chronology') from error
        superseded[old] = rule
    if any((rule['sourceSha256'], rule['newOutputSha256']) in superseded for rule in superseded.values()):
        raise ValueError('Chained supersession is ambiguous')

    cache = {}

    def image(meta):
        if meta.get('path'):
            path = Path(meta['path']).resolve()
        else:
            url = urlsplit(meta['url'])
            if url.scheme or url.netloc or url.query or url.fragment:
                raise ValueError('Image URL must be a local path')
            path = (catalog_path.parent / unquote(url.path)).resolve()
        if not path.is_relative_to(private):
            raise ValueError('Image path escapes private-assets')
        if path not in cache:
            with Image.open(path) as opened:
                opened.load()
                cache[path] = {'path': str(path), 'sha256': sha256(path), 'dimensions': list(opened.size),
                               'opaque': opened.convert('RGBA').getchannel('A').getextrema() == (255, 255)}
        actual = cache[path]
        if actual['sha256'] != meta.get('sha256') or actual['dimensions'] != meta.get('dimensions'):
            raise ValueError('Image hash or dimensions mismatch: ' + str(path))
        return {k: actual[k] for k in ('path', 'sha256', 'dimensions')}

    approved_images = {}
    for key in sorted(approvals):
        matches = artifacts[key]
        sources = [image(r['source']) for r in matches]
        outputs = [image(r['output']) for r in matches]
        if any(not cache[Path(out['path'])]['opaque'] for out in outputs):
            raise ValueError('Approved output is not opaque')
        approved_images[key] = {'artifactId': ':'.join(key), 'source': sources[0], 'output': outputs[0],
                                'outputPaths': sorted({meta['path'] for meta in outputs}),
                                'approvalEvidence': approvals[key],
                                'candidateIdentities': [identity(r) for r in matches]}

    groups, excluded = {}, []
    for row in rows:
        if row.get('category') == 'paired-experiment':
            excluded.append(identity(row))
            continue
        source = (row.get('source') or {}).get('sha256')
        if not source:
            raise ValueError('Catalog row lacks exact source identity')
        groups.setdefault(source, []).append(row)
    selected, unapproved, conflicts = [], [], []
    for source, source_rows in sorted(groups.items()):
        identities = [{**identity(r), **{k: r.get(k) for k in ('roomId', 'resourceId', 'aliases')},
                       'sourceBinding': r.get('provenance', {}).get('sourceBinding', {}),
                       'additionalSources': r.get('additionalSources', [])} for r in sorted(source_rows, key=lambda r: r['id'])]
        common = {'sourceSha256': source, 'identities': identities,
                  'aliases': sorted({a for r in source_rows for a in r.get('aliases', [])})}
        choices = sorted({pair(identity(r)) for r in source_rows
                          if pair(identity(r)) in approvals and pair(identity(r)) not in superseded})
        if len(choices) > 1:
            conflicts.append({**common, 'reason': 'multiple-approved-outputs',
                              'approvedOutputSha256': [key[1] for key in choices],
                              'approvedChoices': [approved_images[key] for key in choices]})
            continue
        if not choices:
            unapproved.append({**common, 'reason': 'no-approved-output',
                               'candidates': [{**identity(r), 'decision': states.get(pair(identity(r)), 'pending'),
                                               'available': bool(r.get('available'))} for r in source_rows]})
            continue
        key = choices[0]
        sources = [image(r['source']) for r in source_rows]
        selected.append({**common, **approved_images[key],
                         'sourcePaths': sorted({meta['path'] for meta in sources}),
                         'supersessions': [rule for old, rule in sorted(superseded.items()) if old[0] == source]})
    summary = {'sourceCount': len(groups), 'selectedSources': len(selected),
               'unapprovedSources': len(unapproved), 'conflictedSources': len(conflicts),
               'sourceAliases': len({a for group in (selected, unapproved, conflicts) for item in group for a in item['aliases']}),
               'selectedSourceAliases': len({a for item in selected for a in item['aliases']}),
               'unapprovedSourceAliases': len({a for item in unapproved for a in item['aliases']}),
               'conflictedSourceAliases': len({a for item in conflicts for a in item['aliases']}),
               'excludedExperimentRows': len(excluded), 'approvedArtifacts': len(approvals),
               'catalogRows': len(rows)}
    return {'schemaVersion': 1, 'private': True, 'valid': not conflicts,
            'purpose': 'offline-human-approved-release-selection',
            'catalogManifestSha256': catalog['manifestSha256'],
            'inputs': [{'path': str(p.resolve()), 'sha256': sha256(p)}
                       for p in (catalog_path, export_path, receipt_path)],
            'summary': summary, 'selected': selected, 'unapproved': unapproved,
            'conflicts': conflicts, 'excludedExperiments': excluded,
            'policy': {'automaticApproval': False, 'runtimePromotion': False, 'networkCalls': 0}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    review = ROOT / 'private-assets/upscaling/gemini-review-all'
    parser.add_argument('--catalog', type=Path, default=review / 'manual-review-data.json')
    parser.add_argument('--review-export', type=Path, default=Path('/home/mosha/Downloads/neverhood-manual-review-edb0ae7286c7.json'))
    parser.add_argument('--accepted-artifacts', type=Path, default=review / 'accepted-artifacts.json')
    parser.add_argument('--private-root', type=Path, default=ROOT / 'private-assets')
    parser.add_argument('--output', type=Path, help='New private JSON path; existing files are never replaced')
    args = parser.parse_args()
    try:
        result = build_selection(args.catalog, args.review_export, args.accepted_artifacts, args.private_root)
        if args.output:
            output = args.output.resolve()
            if not output.is_relative_to(args.private_root.resolve()) or not output.parent.is_dir():
                raise ValueError('Output must have an existing parent inside private-assets')
            fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                json.dump(result, stream, indent=2, ensure_ascii=True)
                stream.write('\n')
        print(json.dumps({'valid': result['valid'], **result['summary'],
                          'output': str(args.output.resolve()) if args.output else None}, sort_keys=True))
        return 0 if result['valid'] else 1
    except (ValueError, KeyError, OSError) as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
