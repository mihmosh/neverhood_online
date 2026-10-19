import test from 'node:test';
import assert from 'node:assert/strict';
import { initVideo } from '../web/hd-demo/video.js';

function fixture(supported = true) {
  class Element extends EventTarget {
    children = [];
    textContent = 'YouTube loads only after you press Play.';
    hidden = false;
    get childElementCount() { return this.children.length; }
    replaceChildren(...children) {
      for (const child of this.children) child.parentNode = null;
      this.children = children;
      for (const child of children) child.parentNode = this;
    }
    focus() { this.focused = true; }
  }
  const elements = new Map(['demo-video-play', 'demo-video-host', 'demo-video-status'].map(id => [id, new Element()]));
  let created = 0;
  const root = { getElementById: id => elements.get(id), createElement(tag) {
    assert.equal(tag, 'iframe'); created++;
    const frame = new Element();
    if (supported) frame.credentialless = false;
    return frame;
  } };
  return { root, play: elements.get('demo-video-play'), host: elements.get('demo-video-host'), status: elements.get('demo-video-status'), created: () => created };
}

test('video makes no iframe before click and uses a credentialless no-cookie embed with an embedder referrer', () => {
  const f = fixture(), reset = initVideo(f.root);
  assert.equal(f.created(), 0);
  f.play.dispatchEvent(new Event('click'));
  const [frame] = f.host.children;
  assert.equal(frame.credentialless, true);
  assert.equal(new URL(frame.src).origin, 'https://www.youtube-nocookie.com');
  assert.equal(new URL(frame.src).pathname, '/embed/-U8jjMIlVU4');
  assert.equal(new URL(frame.src).searchParams.get('autoplay'), '1');
  assert.equal(frame.referrerPolicy, 'strict-origin-when-cross-origin');
  assert.match(frame.allow, /fullscreen/); assert.equal(frame.allowFullscreen, true);
  assert.equal(f.play.hidden, true); assert.equal(frame.focused, true);
  f.play.dispatchEvent(new Event('click')); assert.equal(f.created(), 1);
  reset(); assert.equal(f.host.children.length, 0); assert.equal(f.play.hidden, false);
  assert.match(f.status.textContent, /only after/);
});

test('unsupported browsers retain the direct link without weakening page isolation', () => {
  const f = fixture(false); initVideo(f.root);
  f.play.dispatchEvent(new Event('click'));
  assert.equal(f.host.children.length, 0); assert.equal(f.play.hidden, false);
  assert.match(f.status.textContent, /YouTube link/);
});

test('iframe load failures allow retry and stale iframe errors cannot remove a new player', () => {
  const f = fixture(); initVideo(f.root);
  f.play.dispatchEvent(new Event('click'));
  const [first] = f.host.children;
  first.dispatchEvent(new Event('error'));
  assert.equal(f.play.hidden, false); assert.match(f.status.textContent, /could not load/);
  f.play.dispatchEvent(new Event('click'));
  const [second] = f.host.children;
  first.dispatchEvent(new Event('error'));
  assert.equal(f.host.children[0], second);
});

test('video initialization is safe when the section is absent', () => {
  assert.doesNotThrow(() => initVideo({ getElementById: () => null })());
});
