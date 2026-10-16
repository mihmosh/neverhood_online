import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('compact launcher prominently credits the upstream Neverhood engine authors', async () => {
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  const credits = html.match(/<aside\b[^>]*id="credits"[^>]*>[\s\S]*?<\/aside>/)?.[0];
  assert.ok(credits, 'engine credits must be a visible page section, not only a footer link');
  for (const name of ['Benjamin Haisch', 'john_doe', 'Filippos Karapetis', 'bluegr']) assert.ok(credits.includes(name), `Missing engine credit: ${name}`);
  assert.match(credits, /scummvm\/scummvm\/blob\/c546a4c80d2daf3bb1d5a3652279e26f762c0204\/engines\/neverhood\/credits\.pl/);
  assert.doesNotMatch(credits.slice(0, credits.indexOf('>') + 1), /\shidden(?:\s|=|>)|\saria-hidden="true"/);
  assert.doesNotMatch(html, /class="intro"/);
  for (const path of ['../README.md', '../THIRD_PARTY_NOTICES.md']) {
    const document = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.ok(document.includes('Benjamin Haisch'));
    assert.ok(document.includes('Filippos Karapetis'));
  }
});
