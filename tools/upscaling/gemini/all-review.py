#!/usr/bin/env python3
"""Build one offline English review from every persisted Gemini background attempt.

No network, generation, image transformations, or runtime-pack writes occur.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
from urllib.parse import quote

from PIL import Image


ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location('neverhood_manual_review', Path(__file__).with_name('manual-review.py'))
REVIEW = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REVIEW)
sha = lambda data: hashlib.sha256(data).hexdigest()


def private_path(value, private):
    """Relocate persisted absolute private paths without trusting the old host root."""
    value = Path(value)
    if value.is_absolute():
        try:
            suffix = value.parts[value.parts.index('private-assets') + 1:]
        except ValueError as error:
            raise ValueError('Persisted artifact is not a private-assets path') from error
        result = private.joinpath(*suffix).resolve()
    else:
        parts = value.parts[1:] if value.parts and value.parts[0] == 'private-assets' else value.parts
        result = private.joinpath(*parts).resolve()
    if not result.is_relative_to(private.resolve()):
        raise ValueError('Artifact escapes the private-assets tree')
    return result


def read_json(path):
    value = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(value, dict):
        raise ValueError('Expected JSON object: ' + str(path))
    return value


def image_info(value, declared, private, output, cache):
    path = private_path(value, private)
    key = str(path)
    if key not in cache:
        data = path.read_bytes()
        with Image.open(path) as opened:
            opened.load()
            rgb = opened.convert('RGB')
            dimensions = list(opened.size)
            rgb_hash = sha(f'{opened.width}x{opened.height}:RGB\0'.encode() + rgb.tobytes())
            cache[key] = {'path': str(path), 'sha256': sha(data), 'bytes': len(data),
                          'dimensions': dimensions, 'mimeType': Image.MIME.get(opened.format),
                          'opaque': opened.convert('RGBA').getchannel('A').getextrema() == (255, 255),
                          'rgbSha256': rgb_hash}
    actual = cache[key]
    if declared.get('sha256') and declared['sha256'] != actual['sha256']:
        raise ValueError('Persisted image checksum mismatch: ' + str(path))
    if declared.get('dimensions') and list(declared['dimensions']) != actual['dimensions']:
        raise ValueError('Persisted image dimensions mismatch: ' + str(path))
    return {**actual, 'url': quote(os.path.relpath(path, output), safe='/')}


def group_label(room_ids, resource_id):
    if 'Scene2810' in room_ids:
        return 'Hall of Fame / Statue Hall (Scene2810)'
    if any(name.startswith('HallOfRecordsScene') for name in room_ids):
        return 'Hall of Records / ' + str(resource_id or next(iter(room_ids)))
    if 'Module1000' in room_ids:
        return 'Window View (Module1000)'
    preferred = sorted(room_ids, key=lambda name: (name.count('-'), len(name), name))[0]
    return preferred.split('-')[0] + (' / ' + resource_id if resource_id else '')


def collect(experiments, output, private):
    cache, groups, rows, attempts, manifest_records = {}, {}, [], [], []
    seen_results = set()
    for manifest_path in sorted(experiments.glob('*/experiment.json')):
        plan = read_json(manifest_path)
        run = manifest_path.parent
        experiment = plan.get('experimentId', run.name)
        manifest_records.append({'path': os.path.relpath(manifest_path, private),
                                 'sha256': sha(manifest_path.read_bytes())})
        room_metadata = {room['id']: room for room in plan.get('rooms', [])}
        checked = read_json(run / 'bulk-check.json') if (run / 'bulk-check.json').exists() else {}
        checked_entries = {entry.get('id'): entry for room in checked.get('rooms', [])
                           for entry in room.get('entries', []) if entry.get('kind') == 'candidate'}
        # Reused references point to attempts already owned by another manifest.
        # Scan only original job records so every actual submission appears once.
        for job in plan.get('jobs', []):
            folder = run / 'jobs' / job['id']
            result_path = folder / 'result.json'
            if not result_path.exists() or result_path.resolve() in seen_results:
                continue
            seen_results.add(result_path.resolve())
            record = read_json(result_path)
            if record.get('requestHash') != job.get('requestHash'):
                raise ValueError('Job/result request hash mismatch: ' + str(result_path))
            request_path = folder / 'request.json'
            request = read_json(request_path) if request_path.exists() else job
            attachments = request.get('attachments', job.get('attachments', []))
            is_pair = experiment == 'paired-lighting-v1'
            sources = [item for item in attachments if item.get('role', '').startswith('source-')]
            if not sources:
                raise ValueError('No original source for persisted image attempt: ' + str(result_path))
            source = image_info(sources[0]['path'], sources[0], private, output, cache)
            other_sources = [{'label': item.get('label', 'Additional original'),
                              'meta': image_info(item['path'], item, private, output, cache)}
                             for item in sources[1:]]
            group_key = 'paired-lighting-experiment' if is_pair else source['rgbSha256']
            group = groups.setdefault(group_key, {'roomIds': set(), 'resources': set(), 'rows': [], 'isPair': is_pair})
            group['roomIds'].add(job['roomId'])
            metadata = room_metadata.get(job['roomId'], {})
            if metadata.get('resourceId'):
                group['resources'].add(metadata['resourceId'])
            finals = [image for image in record.get('images', []) if not image.get('thought')
                      and str(image.get('mimeType', '')).startswith('image/')]
            category = ('paired-experiment' if is_pair else 'historical-experiment'
                        if experiment.startswith(('static-pilot-', 'static-text-material-')) else 'production')
            current = checked_entries.get(job['id'], {})
            issues = list(current.get('issues', []))
            if category == 'historical-experiment':
                issues.append({'kind': 'historical-experiment', 'reason': 'Historical model/prompt/reference experiment, not the current production preservation default.', 'severity': 'diagnostic'})
            if is_pair:
                issues.append({'kind': 'unmapped-paired-experiment', 'reason': 'Two originals were supplied but only one final image was returned. This is not two mapped background restorations.', 'severity': 'diagnostic'})
            attempt = {'experimentId': experiment, 'jobId': job['id'], 'requestHash': job['requestHash'],
                       'resultPath': os.path.relpath(result_path, private), 'resultSha256': sha(result_path.read_bytes()),
                       'status': record.get('status'), 'responseId': record.get('responseId'),
                       'model': job.get('model'), 'modelVersion': record.get('modelVersion'),
                       'promptVariant': job.get('promptVariant'), 'referenceMode': job.get('referenceMode'),
                       'finalImageCount': len(finals), 'sourceSha256': source['sha256']}
            attempts.append(attempt)
            for part, declared in enumerate(finals or [None]):
                image = image_info(declared['path'], declared, private, output, cache) if declared else None
                valid = bool(image and image['opaque'] and image['mimeType'] in ('image/png', 'image/jpeg'))
                artifact_id = source['sha256'] + ':' + (image['sha256'] if image else 'unavailable:' + experiment + '::' + job['id'])
                row = {'id': f'{experiment}::{job["id"]}::{part}', 'candidateId': job['id'], 'artifactId': artifact_id,
                       'source': source, 'output': image, 'available': bool(image), 'canApprove': valid and not is_pair,
                       'origin': 'historical' if category == 'historical-experiment' else 'new', 'category': category,
                       'startedAt': record.get('startedAt'), 'observedStatus': record.get('status'),
                       'technicalStatus': 'valid' if valid else 'unavailable' if not image else 'invalid',
                       'provenanceStatus': current.get('provenanceStatus', 'complete' if (folder / 'response-raw.json').exists() else 'incomplete'),
                       'visualReviewStatus': current.get('visualReviewStatus', 'manual-review-required'),
                       'issues': issues, 'attempts': [attempt], 'additionalSources': other_sources,
                       'provenance': {'experimentId': experiment, 'model': job.get('model'), 'modelVersion': record.get('modelVersion'),
                                      'promptVariant': job.get('promptVariant'), 'referenceMode': job.get('referenceMode'),
                                      'requestHash': job['requestHash'], 'result': os.path.relpath(result_path, private),
                                      'sourceBinding': metadata.get('provenance', {})}}
                existing = next((item for item in group['rows'] if image and item['artifactId'] == artifact_id), None)
                if existing:
                    existing['attempts'].append(attempt)
                else:
                    group['rows'].append(row)
    for key, group in sorted(groups.items(), key=lambda item: sorted(item[1]['roomIds'])[0]):
        aliases = sorted(group['roomIds'])
        resource = ', '.join(sorted(group['resources']))
        label = 'Paired Lighting Experiment (Unmapped)' if group['isPair'] else group_label(aliases, resource)
        group_id = 'experiment:paired-lighting' if group['isPair'] else 'background:' + key[:20]
        candidates = sorted(group['rows'], key=lambda row: (row.get('startedAt') or '', row['id']))
        for index, row in enumerate(candidates):
            row.update({'roomId': group_id, 'groupLabel': label, 'label': label + (f' / v{index + 1}' if len(candidates) > 1 else ''),
                        'resourceId': resource or None, 'aliases': aliases, 'versionIndex': index + 1,
                        'versionCount': len(candidates), 'versionLabel': f'v{index + 1}'})
            rows.append(row)
    rows.sort(key=lambda row: (row['category'] == 'paired-experiment', row['groupLabel'].casefold(), row['roomId'], -row['versionIndex']))
    index = {'schemaVersion': 1, 'purpose': 'all-persisted-gemini-background-review',
             'manifests': manifest_records, 'attempts': attempts,
             'artifacts': [{'artifactId': row['artifactId'], 'sourceSha256': row['source']['sha256'],
                            'outputSha256': row['output']['sha256'] if row['output'] else None} for row in rows],
             'policy': {'thoughtImagesIncluded': False, 'originalsGroupedByDecodedRgb': True,
                        'historicalExperimentsIncluded': True, 'pairedExperimentMappedToRoom': False,
                        'automaticApproval': False, 'paidCalls': 0}}
    summary = {'originalBackgrounds': sum(not group['isPair'] for group in groups.values()),
               'experimentGroups': sum(group['isPair'] for group in groups.values()),
               'savedFinalImages': sum(row['available'] for row in rows),
               'independentFinalVersions': sum(row['available'] and row['category'] != 'paired-experiment' for row in rows),
               'pairedExperimentImages': sum(row['available'] and row['category'] == 'paired-experiment' for row in rows),
               'archivedAttemptsWithoutImage': sum(not row['available'] for row in rows),
               'reviewRows': len(rows), 'originalStatesWithoutAnyResult': sum(not group['isPair'] and not any(row['available'] for row in group['rows']) for group in groups.values())}
    data = {'schemaVersion': 2, 'private': True, 'manifestSha256': sha(json.dumps(index, sort_keys=True).encode()),
            'experimentId': 'neverhood-all-backgrounds', 'rooms': rows, 'summary': summary,
            'coverageSummary': summary, 'coverageNote': 'All persisted final background versions, including historical experiments. Thought previews are excluded. The joint-lighting output is an unmapped experiment, not a room replacement.',
            'exclusions': [], 'relatedReviews': [], 'technicalReportUrl': 'all-review-index.json', 'technicalReportLabel': 'Catalog JSON'}
    return data, index


def write(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as stream:
        stream.write(value)


def apply_saved_decisions(data, receipt):
    if receipt.get('schemaVersion') != 1 or receipt.get('reviewer') != 'user' or not receipt.get('receiptId'):
        raise ValueError('Invalid saved human-approval receipt')
    saved = []
    for decision in receipt.get('decisions', []):
        matches = [row for row in data['rooms'] if row['source']['sha256'] == decision.get('sourceSha256')
                   and (row.get('output') or {}).get('sha256') == decision.get('outputSha256')]
        if len(matches) != 1 or not matches[0]['canApprove'] or decision.get('decision') != 'approved':
            raise ValueError('Saved approval does not identify one approvable exact artifact')
        row = matches[0]
        saved.append({'id': row['id'], 'candidateId': row['candidateId'], 'sourceSha256': decision['sourceSha256'],
                      'outputSha256': decision['outputSha256'], 'decision': 'approved', 'notes': decision.get('notes', '')})
    data['savedDecisions'] = saved
    data['savedDecisionReceiptId'] = receipt['receiptId']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--experiments', type=Path, default=ROOT / 'private-assets/upscaling/gemini-experiments')
    parser.add_argument('--output', type=Path, default=ROOT / 'private-assets/upscaling/gemini-review-all')
    parser.add_argument('--overwrite', action='store_true')
    args = parser.parse_args()
    private = (ROOT / 'private-assets').resolve()
    experiments, output = args.experiments.resolve(), args.output.resolve()
    if not experiments.is_relative_to(private) or not output.is_relative_to(private):
        raise ValueError('Experiment inputs and generated review must remain private')
    output.mkdir(parents=True, exist_ok=True)
    targets = [output / name for name in ('all-review-index.json', 'manual-review-data.json', 'review.html')]
    if any(target.exists() for target in targets) and not args.overwrite:
        raise FileExistsError('Review exists; use --overwrite to rebuild without changing artifact identities')
    previous = read_json(targets[1]) if targets[1].exists() else None
    data, index = collect(experiments, output, private)
    receipt_path = output / 'accepted-artifacts.json'
    if receipt_path.exists():
        apply_saved_decisions(data, read_json(receipt_path))
    if previous:
        previous_hash = previous.get('manifestSha256')
        if previous_hash != data['manifestSha256']:
            data['previousCatalogManifestSha256'] = previous_hash
        elif previous.get('previousCatalogManifestSha256'):
            data['previousCatalogManifestSha256'] = previous['previousCatalogManifestSha256']
    write(targets[0], json.dumps(index, indent=2, ensure_ascii=True) + '\n')
    write(targets[1], json.dumps(data, indent=2, ensure_ascii=True) + '\n')
    write(targets[2], REVIEW.render(data))
    print(json.dumps({'review': str(targets[2]), **data['summary'], 'paidCalls': 0}))


if __name__ == '__main__':
    main()
