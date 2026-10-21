#!/usr/bin/env python3
"""Read-only lexical C++ static-sprite candidates, never scene/asset bindings."""

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[3]
IDENT = r"[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*"
METHOD = re.compile(
    r"^[ \t]*(?:[\w:*&<>~,]+[ \t]+)*[*&]*\s*(?P<class>" + IDENT
    + r")::(?P<method>~?[A-Za-z_]\w*)\s*\(", re.M)
CALL = re.compile(
    r"\b(?:(?P<insertStatic>insertStaticSprite)\s*|"
    r"(?P<insert>insertSprite)\s*<\s*(?P<template>" + IDENT + r")\s*>\s*|"
    r"new\s+(?P<new>" + IDENT + r")\s*|(?P<load>loadSprite)\s*)\(")


def lexical_mask(text):
    """Blank comments and C++ strings/chars without changing offsets or lines."""
    result = list(text)
    token = re.compile(r'//(?:\\\r?\n|[^\n])*|/\*[\s\S]*?(?:\*/|\Z)|'
                       r'(?:u8|u|U|L)?R"([^ ()\\\t\r\n]{0,16})\([\s\S]*?\)\1"|'
                       r'"(?:\\[\s\S]|[^"\\])*"|\'(?:\\[\s\S]|[^\'\\])*\'')
    for match in token.finditer(text):
        for index in range(match.start(), match.end()):
            if result[index] not in "\r\n":
                result[index] = " "
    return "".join(result)


def _pairs(mask):
    stack, pairs = [], {}
    for index, char in enumerate(mask):
        if char in "([{":
            stack.append((char, index))
        elif char in ")]}":
            if stack and stack[-1][0] == {')': '(', ']': '[', '}': '{'}[char]:
                _, start = stack.pop()
                pairs[start] = index
    return pairs


def _arguments(text, mask, opening, pairs):
    closing = pairs.get(opening)
    if closing is None:
        return [], None
    arguments, start, index = [], opening + 1, opening + 1
    while index < closing:
        if index in pairs:
            index = pairs[index] + 1
            continue
        if mask[index] == '<' and re.search(r'[\w>]\s*$', mask[start:index]):
            depth, cursor = 1, index + 1
            while cursor < closing and depth:
                if cursor in pairs:
                    cursor = pairs[cursor] + 1
                    continue
                if mask[cursor] == '<':
                    depth += 1
                elif mask[cursor] == '>':
                    depth -= 1
                cursor += 1
            # Only recognize template calls/casts/initializers, not comparisons.
            if depth == 0 and mask[cursor:closing].lstrip().startswith(('(', '{', '::')):
                index = cursor
                continue
        if mask[index] == ',':
            arguments.append(text[start:index].strip())
            start = index + 1
        index += 1
    if text[start:closing].strip() or arguments:
        arguments.append(text[start:closing].strip())
    return arguments, closing


def _methods(mask, pairs):
    methods = []
    for match in METHOD.finditer(mask):
        opening = match.end() - 1
        closing = pairs.get(opening)
        if closing is None:
            continue
        index = closing + 1
        # Initializer argument lists must not be mistaken for the method body.
        while index < len(mask):
            if mask[index] == ';':
                break
            if mask[index] == '(' and index in pairs:
                index = pairs[index] + 1
                continue
            if mask[index] == '{':
                # A braced member initializer is followed by ',' or the body.
                end = pairs.get(index)
                if end is None:
                    break
                prefix = mask[closing + 1:index].rstrip()
                after = mask[end + 1:].lstrip()
                if ':' in prefix and re.search(r'[\w>]$', prefix) and after.startswith((',', '{')):
                    index = end + 1
                    continue
                methods.append({"start": match.start(), "nameStart": match.start('method'),
                                "body": index, "end": end + 1,
                                "scopeClass": match.group('class'),
                                "method": match.group('method')})
                break
            index += 1
    return methods


def _inheritance(sources):
    classes = {}
    for path, text in sources.items():
        mask = lexical_mask(text)
        for match in re.finditer(r'\bclass\s+(' + IDENT + r')\s*(?:final\s*)?(?::([^;{}]+))?\{', mask):
            bases = []
            unresolved = False
            for base in (match.group(2) or '').split(','):
                base = re.sub(r'\b(public|protected|private|virtual)\b', '', base).strip()
                if re.fullmatch(IDENT, base):
                    bases.append(base)
                elif base:
                    unresolved = True
            name = match.group(1)
            classes.setdefault(name, []).append({"path": path, "line": text.count('\n', 0, match.start()) + 1,
                                                 "bases": bases, "inheritanceUnresolved": unresolved})
    proven = {"StaticSprite"}
    while True:
        added = {name for name, declarations in classes.items()
                 if len(declarations) == 1 and any(base in proven for base in declarations[0]['bases'])}
        if added <= proven:
            break
        proven |= added
    non_static = set()
    while True:
        added = {name for name, declarations in classes.items()
                 if name not in proven and len(declarations) == 1
                 and not declarations[0]['inheritanceUnresolved']
                 and all(base in non_static for base in declarations[0]['bases'])}
        if added <= non_static:
            break
        non_static |= added
    return classes, proven, non_static


def _literal(expression):
    cleaned = lexical_mask(expression).strip()
    if not re.fullmatch(r'(?:0[xX][0-9a-fA-F]+|[0-9]+)(?:[uU](?:[lL]{1,2})?|[lL]{1,2}[uU]?)?', cleaned):
        return None
    number = re.sub(r'[uUlL]+$', '', cleaned)
    # Do not misread C++ octal constants as decimal.
    base = 16 if number.lower().startswith('0x') else 8 if len(number) > 1 and number.startswith('0') else 10
    try:
        value = int(number, base)
    except ValueError:
        return None
    return f'{value:08x}' if 0 <= value <= 0xffffffff else None


def _evidence(text, mask, start, end):
    operations = {"geometryOperations": [], "paletteOperations": []}
    pattern = re.compile(r'\b(?:setPosition|setX|setY|setDrawOffset|setClipRect|setClippingRect|'
                         r'setDoDeltaX|setDoDeltaY|setFlip\w*|flip\w*|\w*[Pp]alette\w*|'
                         r'_x|_y|_doDeltaX|_doDeltaY)\b')
    seen = set()
    for match in pattern.finditer(mask, start, end):
        line_start = text.rfind('\n', start, match.start()) + 1
        line_end = text.find('\n', match.end(), end)
        if line_end < 0:
            line_end = end
        key = (line_start, line_end)
        if key in seen:
            continue
        seen.add(key)
        kind = 'paletteOperations' if 'palette' in match.group().lower() else 'geometryOperations'
        operations[kind].append({"line": text.count('\n', 0, match.start()) + 1,
                                 "excerpt": text[line_start:line_end].strip()})
    return operations


def scan_texts(sources):
    """Scan a {relative POSIX path: C++ text} fixture, including header inheritance."""
    sources = dict(sorted(sources.items()))
    classes, proven, non_static = _inheritance(sources)
    uses, raw, excluded = [], Counter(), Counter()
    files = []
    for path, text in sources.items():
        files.append({"path": path, "sha256": hashlib.sha256(text.encode('utf-8')).hexdigest(),
                      "role": 'source' if path.endswith('.cpp') else 'inheritance-header'})
        if not path.endswith('.cpp'):
            continue
        mask = lexical_mask(text)
        pairs = _pairs(mask)
        methods = _methods(mask, pairs)
        calls = []
        for match in CALL.finditer(mask):
            pattern = ('insertStaticSprite' if match.group('insertStatic') else
                       'insertSprite' if match.group('insert') else
                       'new' if match.group('new') else 'loadSprite')
            target = match.group('template') or match.group('new')
            calls.append((match.start(), match.end() - 1, pattern, target))
        # Base initializers supply the resource for many static-derived helpers.
        for method in methods:
            if method['scopeClass'] not in proven or method['method'] != method['scopeClass'].split('::')[-1]:
                continue
            for match in re.finditer(r'\b(' + IDENT + r')\s*\(', mask[method['start']:method['body']]):
                if match.group(1) in proven and match.group(1) != method['scopeClass']:
                    calls.append((method['start'] + match.start(), method['start'] + match.end() - 1,
                                  'staticBaseInitializer', match.group(1)))
        for offset, opening, pattern, target in sorted(calls):
            raw[pattern] += 1
            contexts = [method for method in methods if method['start'] <= offset < method['end']]
            context = min(contexts, key=lambda item: item['end'] - item['start']) if contexts else None
            if context and offset == context['nameStart']:
                excluded['methodDefinition'] += 1
                continue
            if pattern == 'loadSprite':
                if not context or context['scopeClass'] not in proven:
                    excluded['loadSpriteOutsideProvenStaticMethod'] += 1
                    continue
                prefix = mask[max(context['start'], offset - 160):offset].rstrip()
                if prefix.endswith(('.', '->', '::')) and not re.search(r'(?:\bthis\s*->|\bStaticSprite\s*::)$', prefix):
                    excluded['loadSpriteOtherReceiver'] += 1
                    continue
            if target in non_static:
                excluded['knownNonStaticClass'] += 1
                continue
            arguments, closing = _arguments(text, mask, opening, pairs)
            resource_index = 1 if target == 'StaticSprite' and pattern in ('new', 'staticBaseInitializer') else 0
            # Derived constructor signatures are not resource argument contracts.
            priority_only = target == 'StaticSprite' and pattern in ('new', 'staticBaseInitializer') and len(arguments) == 2
            direct = (pattern in ('insertStaticSprite', 'loadSprite') or target == 'StaticSprite') and not priority_only
            expression = arguments[resource_index] if direct and len(arguments) > resource_index else None
            resource = _literal(expression) if expression is not None else None
            begin = context['start'] if context else offset
            end = context['end'] if context else (closing + 1 if closing is not None else opening + 1)
            call_end = closing + 1 if closing is not None else opening + 1
            constructor = bool(context and context['method'] == context['scopeClass'].split('::')[-1])
            use = {
                "id": f'{path}:{text.count(chr(10), 0, offset) + 1}:{offset}:{pattern}',
                "scopeClass": context['scopeClass'] if context else None,
                "method": context['method'] if context else None,
                "function": f"{context['scopeClass']}::{context['method']}" if context else None,
                "resource": resource, "requestedResource": resource,
                "expression": expression if expression is not None else ', '.join(arguments),
                "arguments": arguments, "pattern": pattern, "targetClass": target,
                "staticClassProven": target in proven if target else pattern == 'insertStaticSprite' or bool(context and context['scopeClass'] in proven),
                "call": text[offset:call_end], "path": path,
                "sourceSHA256": files[-1]['sha256'], "line": text.count('\n', 0, offset) + 1,
                "excerpt": text[max(text.rfind('\n', 0, offset) + 1, begin):call_end].strip(),
                "stateContext": {"path": path, "startLine": text.count('\n', 0, begin) + 1,
                                 "endLine": text.count('\n', 0, end) + 1,
                                 "excerpt": text[begin:end], "evidenceOnly": True},
                "constructorStateExcerpt": text[begin:end] if constructor else None,
                "bindingStatus": 'source-candidate-needs-context' if resource else 'unresolved-resource-expression',
                "reviewBlocked": True,
                "reviewReasons": ['scene-palette-placement-and-runtime-state-not-bound'],
            }
            if resource is None:
                use['reviewReasons'].append('dynamic-or-array-expression' if direct else 'constructor-or-helper-resource-contract-unresolved')
            if priority_only:
                use['reviewReasons'].append('static-constructor-object-priority-overload-has-no-resource')
            if target and target not in proven:
                use['reviewReasons'].append('unrecognized-class-inheritance')
            if closing is None:
                use['reviewReasons'].append('unbalanced-call')
            use.update(_evidence(text, mask, begin, end))
            uses.append(use)
    candidates = Counter(use['pattern'] for use in uses)
    patterns = ('insertStaticSprite', 'insertSprite', 'new', 'loadSprite', 'staticBaseInitializer')
    return {"schemaVersion": 1, "kind": 'static-source-candidate-index', "files": files,
            "uses": uses, "classes": classes, "provenStaticClasses": sorted(proven),
            "coverage": {"cppFilesScanned": sum(path.endswith('.cpp') for path in sources),
                         "headerFilesScanned": sum(not path.endswith('.cpp') for path in sources),
                         "rawCallCount": sum(raw.values()), "rawCallsByPattern": dict(sorted(raw.items())),
                         "candidateCount": len(uses), "candidatesByPattern": dict(sorted(candidates.items())),
                         "excludedCounts": dict(sorted(excluded.items())),
                         "literalResourceCount": sum(use['resource'] is not None for use in uses),
                         "patterns": {pattern: {"raw": raw[pattern], "candidates": candidates[pattern],
                                                "excluded": raw[pattern] - candidates[pattern]}
                                      for pattern in patterns},
                         "completeGameClosure": False},
            "scopeLimits": [
                'Lexical candidates, not a C++ compiler or proof of complete game closure.',
                'All .cpp files are scanned; .h/.hpp headers supply inheritance evidence only.',
                'Comments and strings are masked; preprocessor branches are not evaluated.',
                'Qualified out-of-line methods only; macros, inline methods, aliases, templates and indirect helper dispatch require review.',
                'Inheritance uses exact class names; duplicate declarations and namespace aliases require review.',
                'Arrays, dynamic expressions and inherited helper/constructor resource contracts are not evaluated; template argument parsing is heuristic.',
                'State, geometry and palette operations are method-local evidence, not resolved bindings or execution order.',
                'No scene inference from filenames, adjacent methods or resource hashes; no bitmap-is-static assumption.',
                'Catalog identities, restoredBG availability and authoritative scene bindings must be joined read-only by the caller.',
                'No image processing, catalog writes, resource loading or asset publication is performed.',
            ]}


def scan_source(root):
    """Scan a project root, ScummVM root, or engines/neverhood directory read-only."""
    root = Path(root).resolve()
    candidates = (root / 'scummvm/engines/neverhood', root / 'engines/neverhood', root)
    source = next((path for path in candidates if path.is_dir() and (path / 'sprite.cpp').is_file()), None)
    if source is None:
        raise ValueError('Cannot locate engines/neverhood with sprite.cpp')
    paths = sorted(path for path in source.rglob('*') if path.is_file() and path.suffix in ('.cpp', '.h', '.hpp'))
    sources = {path.relative_to(root).as_posix(): path.read_bytes().decode('utf-8') for path in paths}
    result = scan_texts(sources)
    result['sourceRoot'] = str(source)
    return result


def private_output(path):
    """Allow only explicitly private project trees or the approved temp tree."""
    path = Path(path).expanduser().resolve()
    if any(part.lower() in ('public', 'dist') for part in path.parts):
        raise ValueError('Public output paths are forbidden')
    allowed = (ROOT / 'private-assets', ROOT / 'private-research', Path('/tmp/kilo'))
    if not any(path.is_relative_to(base.resolve()) and path != base.resolve() for base in allowed):
        raise ValueError('Output must be inside private-assets, private-research, or /tmp/kilo')
    if path.suffix.lower() != '.json':
        raise ValueError('Output must be a .json file')
    return path


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        output = private_output(args.output)
        result = scan_source(args.root)
        output.parent.mkdir(parents=True, exist_ok=True)
        # Never replace a catalog, existing index, or a concurrent writer's output.
        with output.open('x', encoding='utf-8') as handle:
            json.dump(result, handle, indent=2, sort_keys=True, allow_nan=False)
            handle.write('\n')
    except (ValueError, OSError) as error:
        parser.error(str(error))


if __name__ == '__main__':
    main()
