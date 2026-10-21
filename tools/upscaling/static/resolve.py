"""Conservative source/catalog join for offline static-layer candidates."""

from copy import deepcopy
from contextlib import closing
import json
from pathlib import Path
import re
import sqlite3
import zlib

import numpy as np
from PIL import Image

import pilot
import source_inventory as inventory


def _record(root, record):
    path = pilot.checked_path(root, record['path'])
    if pilot.digest(path.read_bytes()) != record['sha256']:
        raise ValueError('metadata-hash-integrity-failure')
    return path


def _frame(db, resource):
    rows = db.execute('SELECT d.*, r.format AS resource_format FROM decodedframes d '
                      'JOIN resources r ON r.id=d.resource_id WHERE d.requested_hash=?',
                      (int(resource, 16),)).fetchall()
    if len(rows) != 1 or rows[0]['list_index'] != 0 or rows[0]['frame_index'] != 0:
        raise ValueError('ambiguous-or-nonzero-decoded-frame')
    row = rows[0]
    if row['resource_format'] != 'bitmap':
        raise ValueError('non-bitmap-resource-format')
    if row['width'] <= 0 or row['height'] <= 0:
        raise ValueError('invalid-source-dimensions')
    return row


def _class_context(root, source_inventory):
    contexts = {}
    for record in source_inventory.get('files', []):
        path = _record(root, record)
        text = path.read_text()
        mask = inventory.lexical_mask(text)
        pairs = inventory._pairs(mask)
        for method in inventory._methods(mask, pairs):
            contexts.setdefault(method['scopeClass'], []).append({
                'path': record['path'], 'sha256': record['sha256'],
                'method': method['method'],
                'startOffset': method['start'],
                'lines': [text.count('\n', 0, method['start']) + 1,
                          text.count('\n', 0, method['end']) + 1],
                'text': text[method['start']:method['end']],
                'mask': mask[method['start']:method['end']],
            })
        for match in re.finditer(r'\bclass\s+(Scene\w*)\s*(?:final\s*)?(?::[^;{}]+)?\{', mask):
            closing = pairs.get(match.end() - 1)
            if closing is not None:
                contexts.setdefault(match.group(1), []).append({
                    'path': record['path'], 'sha256': record['sha256'], 'method': '<declaration>',
                    'text': text[match.start():closing + 1], 'mask': mask[match.start():closing + 1]})
    return contexts


def _target_context(use, constructor, methods):
    """Check the factory result, not actors sharing its scene constructor."""
    mask = constructor['mask']
    offset = int(use['id'].rsplit(':', 2)[1]) - constructor['startOffset']
    end = offset + len(use['call'])
    before, after = mask[:offset], mask[end:]
    before = re.sub(r'\b(?:this\s*->|Scene\s*::)\s*$', '', before)
    assignment = re.search(r'(?<![\w.>])(?:(?:this\s*->)\s*)?(\w+)\s*=(?!=)\s*'
                           r'(?:\(\s*(?:StaticSprite|Sprite)\s*\*\s*\)\s*)*$', before)
    receiver = assignment.group(1) if assignment else None
    if not receiver:
        if not re.match(r'\s*;', after):
            raise ValueError('static-target-escape-or-chained-operation')
        # A bare expression or a direct conditional statement owns no pointer.
        prefix = before[max(before.rfind(';'), before.rfind('{'), before.rfind('}')) + 1:].strip()
        if prefix and not re.fullmatch(r'(?:else\s*)?(?:(?:if|while|for)\s*\([\s\S]*\)\s*)?', prefix):
            raise ValueError('static-target-escape-or-alias-unproven')
        return {'receiver': None, 'scope': 'unretained-factory-result', 'operations': []}
    name = re.escape(receiver)
    if re.search(r'=\s*$', before[:assignment.start()]):
        raise ValueError('static-target-escape-or-alias-unproven')
    local = any(re.search(r'\b' + name + r'\s*(?:[,;=]|$)', declaration.group())
                for declaration in re.finditer(r'\b(?:Sprite|StaticSprite|auto)\b[^;{}]*(?:;|$)', before))
    segments = methods if not local else [{'mask': after, 'method': constructor['method']}]
    if local:
        reassigned = re.search(r'\b' + name + r'\s*=(?!=)', after)
        if reassigned:
            rhs = after[reassigned.end():].split(';', 1)[0]
            if re.search(r'\b' + name + r'\b', rhs):
                raise ValueError('static-target-escape-or-alias-unproven')
            segments = [{'mask': after[:reassigned.start()], 'method': constructor['method']}]
    operations = []
    for method in segments:
        segment = method['mask']
        for found in re.finditer(r'\b' + name + r'\b', segment):
            tail = segment[found.end():]
            prefix = segment[max(0, found.start() - 80):found.start()]
            if re.match(r'\s*=(?!=)', tail):
                continue
            if re.match(r'\s*[,;]', tail):
                statement_prefix = segment[max(segment.rfind(';', 0, found.start()),
                                               segment.rfind('{', 0, found.start())) + 1:found.start()]
                if ('=' not in statement_prefix and re.search(r'\b(?:Sprite|StaticSprite)\s*\*', statement_prefix)
                        and re.search(r'\*\s*$', statement_prefix)):
                    continue
            if re.search(r'\bdelete\s*$', prefix):
                raise ValueError('target-geometry-or-state-context-unproven')
            call = re.match(r'\s*->\s*(\w+)\s*\(', tail)
            if call:
                operation = call.group(1)
                operations.append({'method': method['method'], 'operation': operation})
                if operation not in ('getDrawRect', 'getBounds', 'getX', 'getY'):
                    raise ValueError('target-geometry-or-state-context-unproven')
                opening = found.end() + call.end() - 1
                closing = inventory._pairs(segment).get(opening)
                if closing is None or re.search(r'&\s*$', prefix):
                    raise ValueError('target-geometry-or-state-context-unproven')
                suffix = segment[closing + 1:]
                scalar = re.match(r'\s*\.\s*(?:(?:x2|y2)\s*\(\s*\)|(?:x|y|width|height)\b)', suffix)
                if scalar:
                    suffix = suffix[scalar.end():]
                if re.match(r'\s*(?:\.|->|\[|[+*/-]?=(?!=)|\+\+|--)', suffix):
                    raise ValueError('target-geometry-or-state-context-unproven')
                continue
            raise ValueError('static-target-escape-or-alias-unproven')
    return {'receiver': receiver, 'scope': 'constructor-local-until-reassignment' if local else 'scene-member',
            'operations': operations}


def _resolve_one(root, catalog_root, db, manifest, use, contexts, background, output):
    scene, resource = use['scopeClass'], use['resource']
    methods = contexts.get(scene, [])
    constructors = [method for method in methods if method['method'] == scene]
    if len(constructors) != 1:
        raise ValueError('ambiguous-scene-constructor')
    declarations = [method for method in methods if method['method'] == '<declaration>']
    if len(declarations) > 1 or any(not re.search(r':\s*public\s+Scene\s*\{', item['mask'])
                                    for item in declarations):
        raise ValueError('inherited-or-ambiguous-scene-context')
    constructor = constructors[0]
    source_path = _record(root, {'path': use['path'], 'sha256': use['sourceSHA256']})
    if constructor['path'] != use['path'] or not constructor['lines'][0] <= use['line'] <= constructor['lines'][1]:
        raise ValueError('source-use-constructor-mismatch')
    # Reparse the actual source rather than trusting a lexical inventory recipe.
    actual = inventory.scan_texts({use['path']: source_path.read_text()})['uses']
    exact = [item for item in actual if item['id'] == use['id'] and item['call'] == use['call']
             and item['resource'] == resource and item['scopeClass'] == scene and item['method'] == scene
             and item['pattern'] == 'insertStaticSprite']
    if len(exact) != 1 or len(exact[0]['arguments']) != 2:
        raise ValueError('literal-direct-factory-binding-unproven')
    priority_text = exact[0]['arguments'][1]
    if not re.fullmatch(r'[0-9]+', priority_text):
        raise ValueError('dynamic-surface-priority')
    target_context = _target_context(use, constructor, methods)
    combined = '\n'.join(method['mask'] for method in methods)
    metadata = background['metadata']
    provenance = metadata['provenance']
    binding = manifest['sourceBinding']
    if not binding or provenance['catalogSourceBinding'] != binding:
        raise ValueError('catalog-source-binding-mismatch')
    _record(root, provenance['codeBinding'])
    bg_resource = inventory._literal(metadata['resourceId'])
    if bg_resource is None:
        raise ValueError('invalid-background-resource')
    palette_calls = re.findall(r'\bsetPalette\s*\(([^()]*)\)', combined)
    if (not re.search(r'\bsetPalette\s*\(', constructor['mask'])
            or not palette_calls or any(inventory._literal(arg) != bg_resource for arg in palette_calls)
            or len(re.findall(r'\bsetPalette\b', combined)) != len(palette_calls)
            or any(token != 'setPalette' for token in re.findall(r'\b\w*[Pp]alette\w*\b', combined))
            or re.search(r'\b(?:fadeToBlack|fadeToWhite)\b', combined)):
        raise ValueError('palette-state-context-unproven')
    bg_calls = re.findall(r'\bsetBackground\s*\(([^()]*)\)', combined)
    if (not re.search(r'\bsetBackground\s*\(', constructor['mask'])
            or not bg_calls or any(inventory._literal(arg) != bg_resource for arg in bg_calls)
            or len(re.findall(r'\bsetBackground\b', combined)) != len(bg_calls)):
        raise ValueError('background-state-context-unproven')
    row, bg_row = _frame(db, resource), _frame(db, bg_resource)
    if (bg_row['width'], bg_row['height']) != (640, 480):
        raise ValueError('invalid-original-background-dimensions')
    if (provenance['decodedFrameId'] != bg_row['id']
            or provenance['indexedPixels']['sha256'] != bg_row['indexed_blob']):
        raise ValueError('background-indexed-binding-mismatch')
    palette_sha = provenance['palette']['sha256']
    palettes = db.execute('SELECT DISTINCT p.blob FROM palettes p JOIN aliases a '
                          'ON a.resolved_id=p.resource_id WHERE a.requested_hash=?',
                          (int(bg_resource, 16),)).fetchall()
    if len(palettes) != 1 or palettes[0]['blob'] != palette_sha:
        raise ValueError('scene-palette-catalog-binding-mismatch')
    palette_bytes = pilot.blob(db, catalog_root, palette_sha)
    _record(root, provenance['palette'])
    _record(root, provenance['indexedPixels'])
    if len(palette_bytes) != 1024:
        raise ValueError('invalid-palette-size')
    palette = np.frombuffer(palette_bytes, np.uint8).reshape(256, 4)
    indexed_bytes = pilot.blob(db, catalog_root, row['indexed_blob'])
    bg_bytes = pilot.blob(db, catalog_root, bg_row['indexed_blob'])
    width, height = row['width'], row['height']
    if len(indexed_bytes) != width * height or len(bg_bytes) != 640 * 480:
        raise ValueError('invalid-indexed-size')
    native = json.loads(row['metadata_json'])
    x, y = native['x'], native['y']
    if (type(x) is not int or type(y) is not int or x < 0 or y < 0
            or x + width > 640 or y + height > 480):
        raise ValueError('source-placement-outside-scene')
    source = _record(root, metadata['source'])
    with Image.open(source) as image:
        original_mode = image.mode
        if (image.size != (640, 480) or image.mode not in ('RGB', 'RGBA', 'P')
                or metadata['source'].get('dimensions', [640, 480]) != [640, 480]):
            raise ValueError('invalid-original-background-image')
        if image.convert('RGBA').getchannel('A').getextrema() != (255, 255):
            raise ValueError('original-background-not-opaque')
        original = np.asarray(image.convert('RGB'))
    expected_bg = palette[np.frombuffer(bg_bytes, np.uint8).reshape(480, 640), :3]
    if not np.array_equal(original, expected_bg):
        raise ValueError('original-background-indexed-RGB-mismatch')
    donors = [entry for entry in background.get('entries', []) if entry.get('observedStatus') == 'succeeded']
    if len(donors) != 1:
        raise ValueError('missing-or-ambiguous-background-donor')
    donor = donors[0]
    if donor.get('technicalStatus') != 'technical-valid':
        raise ValueError('background-upstream-technical-failure')
    donor_path = _record(root, donor['output'])
    with Image.open(donor_path) as image:
        if (list(image.size) != donor['output']['dimensions'] or image.width <= 0 or image.height <= 0
                or donor['output'].get('opaque') is not True
                or image.convert('RGBA').getchannel('A').getextrema() != (255, 255)):
            raise ValueError('invalid-opaque-background-donor')
    indices = np.frombuffer(indexed_bytes, np.uint8).reshape(height, width)
    visible = indices != 0
    rgb = palette[indices, :3]
    if not visible.any() or not np.array_equal(rgb[visible], original[y:y + height, x:x + width][visible]):
        raise ValueError('independent-or-state-RGB-required')
    canvas_width = (width + 3) // 4 * 4
    padded = np.zeros((height, canvas_width), np.uint8)
    padded[:, :width] = indices
    key = f'{canvas_width}x{height}-{canvas_width}-{zlib.crc32(padded.tobytes()):08x}-p{zlib.crc32(palette_bytes):08x}-0'
    semantics = []
    for name, line in (('scene.cpp', 217), ('sprite.cpp', 123)):
        path = pilot.checked_path(root, 'scummvm/engines/neverhood/' + name)
        semantics.append({'path': str(path), 'sha256': pilot.digest(path.read_bytes()), 'line': line,
                          'excerpt': '\n'.join(path.read_text().splitlines()[line - 1:line + 11])})
    rgba = np.empty((height, width, 4), np.uint8)
    rgba[:, :, :3], rgba[:, :, 3] = rgb, np.where(visible, 255, 0)
    identity = {'scene': scene, 'resource': resource, 'frameId': row['id'], 'frame': 0, 'list': 0,
                'indexedSHA256': row['indexed_blob'], 'runtimeIndexedSHA256': pilot.digest(padded.tobytes()),
                'indexedPixels': {'sha256': row['indexed_blob'], 'path': str(pilot.checked_path(
                    catalog_root, db.execute('SELECT path FROM blobs WHERE sha256=?',
                                             (row['indexed_blob'],)).fetchone()['path']))},
                'paletteResource': bg_resource, 'paletteSHA256': palette_sha,
                'paletteCRC32': f'{zlib.crc32(palette_bytes):08x}', 'transparentIndex': 0,
                'runtimeKey': key, 'flipX': False, 'nativeMetadata': native,
                'initialPriority': int(priority_text), 'sourceBinding': binding,
                'constructorSemantics': semantics, 'code': {'path': use['path'],
                    'sha256': use['sourceSHA256'], 'line': use['line'], 'call': use['call']},
                'bindingUseId': use['id'], 'targetContext': target_context,
                'statePredicateResolution': 'source-evidence-only',
                'processingScope': 'individual-base-context-candidate-not-gameplay-verified',
                'stateContext': deepcopy(use.get('stateContext')),
                'classMethodEvidence': [{key: value for key, value in method.items()
                                         if key not in ('mask', 'startOffset')} for method in methods],
                'background': deepcopy(metadata),
                'rasterRecipe': {'nativeContent': [width, height], 'pitch': canvas_width,
                                 'padding': 'zero-index-right-to-multiple-of-four',
                                 'placement': 'unmodified-native-metadata', 'transparentIndex': 0}}
    fingerprint = pilot.digest(json.dumps(identity, sort_keys=True).encode())
    path = Path(pilot.save_image(Image.fromarray(rgba), output / 'sources' / (fingerprint + '.png')))
    sha = pilot.digest(path.read_bytes())
    _record(output, {'path': str(path), 'sha256': sha})
    asset = {'id': f'{scene}-{resource}-{fingerprint}', 'kind': 'foreground-occluder',
            'sourcePath': str(path), 'sourceSHA256': sha, 'contentSize': [width, height],
            'canvasSize': [canvas_width, height], 'placement': [x, y], 'sourceIdentity': identity,
            'backgroundCorrespondence': 'explicit-scene-binding'}
    if original_mode == 'RGB':
        asset['originalBackgroundPath'] = str(source)
    else:
        original_path = Path(pilot.save_image(Image.fromarray(original), output / 'original-backgrounds' /
                                             (metadata['source']['sha256'] + '.png')))
        original_sha = pilot.digest(original_path.read_bytes())
        _record(output, {'path': str(original_path), 'sha256': original_sha})
        asset['originalBackgroundPath'] = str(original_path)
        asset['originalBackgroundSHA256'] = original_sha
    return asset


def resolve_candidates(root, catalog_root, source_inventory, background_check, prepared_assets, output_root):
    """Keep every source use; only prove literal, constructor-local crop recipes."""
    root, catalog_root, output = (Path(path).resolve() for path in (root, catalog_root, output_root))
    allowed = (root / 'private-assets', root / 'private-research', Path('/tmp/kilo'))
    if (any(part.lower() in ('public', 'dist') for part in output.parts)
            or not any(output.is_relative_to(path) and output != path for path in allowed)):
        raise ValueError('Output must be in a private folder or /tmp/kilo')
    prepared = prepared_assets.get('assets', []) if isinstance(prepared_assets, dict) else prepared_assets
    entries = []
    try:
        contexts = _class_context(root, source_inventory)
        manifest = json.loads((catalog_root / 'manifest.json').read_text())
        setup_error = None
    except (ValueError, OSError, KeyError) as error:
        contexts, manifest, setup_error = {}, {}, str(error)
    with closing(sqlite3.connect((catalog_root / 'catalog.sqlite').as_uri() + '?mode=ro', uri=True)) as db, db:
        db.row_factory = sqlite3.Row
        for use in source_inventory['uses']:
            scene, resource = use.get('scopeClass'), use.get('resource')
            entry = {'id': use['id'], 'scene': scene, 'resource': resource, 'kind': 'unresolved-static-context',
                     'processingStatus': 'blocked', 'blockedReasons': [], 'sourceEvidence': deepcopy(use),
                     'approvalStatus': 'review-required', 'automaticApproval': False, 'runtimePromotion': False}
            entries.append(entry)
            try:
                if setup_error:
                    raise ValueError(setup_error)
                if (not scene or not scene.startswith('Scene') or use.get('method') != scene
                        or use.get('pattern') != 'insertStaticSprite' or not resource
                        or not re.fullmatch('[0-9a-f]{8}', resource)):
                    raise ValueError('unsupported-source-context-pending-state-binding')
                repeated = [item for item in source_inventory['uses'] if item.get('scopeClass') == scene
                            and item.get('resource') == resource and item.get('method') == scene]
                matches = []
                for item in prepared or []:
                    evidence = item.get('sourceEvidence', {}).get('constructor', {})
                    if (item['scene'] == scene and item['resource'] == resource
                            and evidence.get('sha256') == use.get('sourceSHA256')
                            and evidence.get('path') == str(pilot.checked_path(root, use['path']))
                            and evidence.get('lines', [1, 0])[0] <= use['line'] <= evidence.get('lines', [1, 0])[1]):
                        matches.append(item['id'])
                if matches and len(repeated) == 1:
                    entry.update(processingStatus='mapped-prepared', preparedBindingIds=matches)
                    continue
                rooms = [room for room in background_check.get('rooms', [])
                         if room.get('metadata', {}).get('id') == scene or any(
                             alias.get('scene') == scene for alias in room.get('metadata', {}).get('bindingAliases', []))]
                if len(rooms) != 1:
                    raise ValueError('missing-or-ambiguous-scene-background-context')
                entry['backgroundRef'] = deepcopy(rooms[0])
                asset = _resolve_one(root, catalog_root, db, manifest, use, contexts, rooms[0], output)
                entry.update(asset=asset, kind=asset['kind'], processingStatus='eligible',
                             sourceOriginalBackgroundVisibleRGB={'exactMatch': True},
                             statePredicateResolution='source-evidence-only',
                             processingScope='individual-base-context-candidate-not-gameplay-verified',
                             reviewFlags=['conditional-execution-and-indirect-scene-effects-not-resolved'],
                             scopeLimits=['Receiver-local lexical checks are not whole-program alias or gameplay proof.'])
            except (ValueError, OSError, KeyError, TypeError, sqlite3.Error) as error:
                entry['blockedReasons'].append(str(error))
    return entries
