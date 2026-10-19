// Importing this module does not load previews or touch the player.
export function initComparison({ originalURL, hdURL, root = document } = {}) {
  const stage = root.getElementById('comparison-stage');
  const original = root.getElementById('comparison-original');
  const hd = root.getElementById('comparison-hd');
  const range = root.getElementById('comparison-range');
  const status = root.getElementById('comparison-status');
  if (!stage || !original || !hd || !range || !status) return () => {};

  const listeners = [];
  const loaded = new Set();
  let disposed = false;
  let failed = false;
  let pointer;
  function listen(target, type, handler) {
    target.addEventListener(type, handler);
    listeners.push(() => target.removeEventListener(type, handler));
  }
  function setPosition(value) {
    const position = Number(value);
    if (!Number.isFinite(position)) return;
    const bounded = Math.max(0, Math.min(100, position));
    range.value = String(bounded);
    range.setAttribute('aria-valuetext', `${Math.round(bounded)}% Original, ${Math.round(100 - bounded)}% HD`);
    stage.style.setProperty('--comparison-position', `${bounded}%`);
  }
  function setState(state, text = '') {
    stage.dataset.state = state;
    stage.setAttribute('aria-busy', String(state === 'loading'));
    range.disabled = state !== 'ready';
    original.hidden = hd.hidden = state !== 'ready';
    status.hidden = state === 'ready';
    status.textContent = text;
  }
  function unavailable() {
    failed = true;
    setState('error', 'Comparison previews could not be loaded. You can still play the demo when it is ready.');
  }
  function move(clientX) {
    if (range.disabled) return;
    const bounds = stage.getBoundingClientRect();
    if (bounds.width > 0) setPosition((clientX - bounds.left) / bounds.width * 100);
  }
  setPosition(50);
  original.removeAttribute('src');
  hd.removeAttribute('src');
  if (typeof originalURL !== 'string' || !originalURL.trim() || typeof hdURL !== 'string' || !hdURL.trim()) {
    setState('unavailable', 'Comparison previews are not available yet. You can still play the demo when it is ready.');
    return () => {};
  }
  setState('loading', 'Loading the comparison previews...');
  for (const [image, url] of [[original, originalURL], [hd, hdURL]]) {
    listen(image, 'load', () => {
      if (disposed || failed) return;
      if (!image.naturalWidth || !image.naturalHeight) return unavailable();
      loaded.add(image);
      if (loaded.size === 2) setState('ready');
    });
    listen(image, 'error', () => { if (!disposed) unavailable(); });
    image.src = url;
  }
  listen(range, 'input', () => setPosition(range.value));
  listen(range, 'keydown', event => {
    if (range.disabled) return;
    const keys = { Home: 0, End: 100, ArrowLeft: Number(range.value) - 1, ArrowDown: Number(range.value) - 1, ArrowRight: Number(range.value) + 1, ArrowUp: Number(range.value) + 1 };
    if (!Object.hasOwn(keys, event.key)) return;
    event.preventDefault();
    setPosition(keys[event.key]);
  });
  listen(stage, 'pointerdown', event => {
    if (range.disabled || event.isPrimary === false || event.button !== 0) return;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, dragging: event.pointerType === 'mouse' };
    if (pointer.dragging) {
      stage.setPointerCapture?.(event.pointerId);
      move(event.clientX);
    }
  });
  listen(stage, 'pointermove', event => {
    if (event.pointerType === 'mouse' && (!pointer || pointer.id === event.pointerId)) return move(event.clientX);
    if (!pointer || pointer.id !== event.pointerId) return;
    const dx = Math.abs(event.clientX - pointer.x);
    const dy = Math.abs(event.clientY - pointer.y);
    // Let a vertical gesture scroll the page; capture only an intentional horizontal drag.
    if (!pointer.dragging && dy > 8 && dy >= dx) { pointer = undefined; return; }
    if (!pointer.dragging && dx > 8 && dx > dy) {
      pointer.dragging = true;
      stage.setPointerCapture?.(event.pointerId);
    }
    if (pointer.dragging) move(event.clientX);
  });
  function release(event) {
    if (pointer?.id !== event.pointerId) return;
    if (stage.hasPointerCapture?.(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    pointer = undefined;
  }
  listen(stage, 'pointerup', release);
  listen(stage, 'pointercancel', release);
  listen(stage, 'lostpointercapture', () => { pointer = undefined; });
  return () => {
    disposed = true;
    if (pointer && stage.hasPointerCapture?.(pointer.id)) stage.releasePointerCapture(pointer.id);
    pointer = undefined;
    for (const remove of listeners) remove();
  };
}
