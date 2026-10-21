#!/usr/bin/env python3
"""Private source-only coverage page; no image generation or resizing."""
import argparse
import hashlib
import html
import json
import os
from pathlib import Path
from urllib.parse import quote


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('run', type=Path)
    args = parser.parse_args()
    run = args.run.resolve()
    private = next((p for p in run.parents if p.name == 'private-assets'), None)
    if not private:
        raise ValueError('Private run required')
    root = private.parent
    plan = json.loads((run / 'experiment.json').read_text())
    selected = plan.get('sourceRegistry', {})
    rows = {}
    for item in selected.get('dispositions', []):
        if not item.get('disposition', '').startswith(('excluded', 'unresolved')):
            continue
        source_path = item.get('sourcePath')
        if not source_path:
            continue
        source = (root / source_path).resolve()
        if not source.is_relative_to(private):
            raise ValueError('Coverage source escapes private assets')
        actual = hashlib.sha256(source.read_bytes()).hexdigest()
        if actual != item.get('sourceSha256'):
            raise ValueError('Coverage original hash mismatch')
        key = item.get('rgbPixelSha256') or actual
        row = rows.setdefault(key, {'path': source, 'sha256': actual, 'scene': item['scene'],
                                   'resourceId': item['resourceId'], 'disposition': item['disposition'],
                                   'reason': item.get('reason', ''), 'states': []})
        row['states'].append(item.get('state', ''))
    esc = html.escape
    page = ['<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
            '<title>Покрытие: не отправленные оригиналы</title><style>body{background:#151817;color:#e7e9df;font:15px Georgia,serif;margin:24px}a{color:#d1dc89}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}article{min-width:0;border:1px solid #384139;padding:14px}img{width:100%;height:auto}p,code{overflow-wrap:anywhere}small{color:#a6afa3}@media(max-width:700px){body{margin:12px}.grid{grid-template-columns:1fr}}</style>',
            '<h1>Оригиналы вне текущей генерации</h1><p><a href="review.html">К результатам ручного ревью</a></p>',
            '<p>Это оригиналы, не результаты Gemini. Ни один из показанных ниже файлов не отправлялся в текущем проходе. ',
            'Зал статуй (Scene2810) включён в основное ревью; зал летописей с текстовыми стенами — другое семейство. ',
            'Стены с летописью выделены отдельно из-за прежнего ограничения на текстовые ассеты; ',
            'генерация с требованием «без текста» могла бы удалить надписи или придумать новые. ',
            'Нестандартный фон 640×500 не обрезан и также не выдаётся за обработанный 640×480.</p>',
            f'<p>Уникальных исходных изображений ниже: {len(rows)}. Повторные привязки и состояния с одинаковым RGB объединены.</p><div class="grid">']
    for item in rows.values():
        url = quote(os.path.relpath(item['path'], run), safe='/')
        page.extend([f'<article><h2>{esc(item["scene"])} / {esc(item["resourceId"])}</h2>',
                     f'<a href="{url}"><img loading="lazy" src="{url}" alt="Необработанный оригинал"></a>',
                     f'<p>{esc(item["disposition"])}</p><p>{esc(item["reason"])}</p>',
                     '<small>SHA-256: ' + esc(item['sha256']) + '</small></article>'])
    page.append('</div><p>Runtime-заливки без отдельного оригинального изображения, UI, маски и отдельные статуи/предметы не подменяют комнатные фоны.</p></html>')
    target = run / 'coverage-review.html'
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write('\n'.join(page))
    print(json.dumps({'page': str(target), 'uniqueExcludedOriginals': len(rows), 'generationCalls': 0}))


if __name__ == '__main__':
    main()
