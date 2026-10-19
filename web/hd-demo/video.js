export function initVideo(root = document) {
  const button = root.getElementById('demo-video-play');
  const host = root.getElementById('demo-video-host');
  const status = root.getElementById('demo-video-status');
  if (!button || !host || !status) return () => {};
  const initialStatus = status.textContent;
  const reset = () => {
    host.replaceChildren();
    button.hidden = false;
    status.textContent = initialStatus;
  };
  button.addEventListener('click', () => {
    if (host.childElementCount) return;
    const frame = root.createElement('iframe');
    // Credentialless embeds preserve the isolated WASM page without requiring YouTube to opt into COEP.
    if (!('credentialless' in frame)) {
      status.textContent = 'This browser cannot embed YouTube on the isolated game page. Use the YouTube link below.';
      return;
    }
    frame.credentialless = true;
    frame.title = 'The Neverhood: Topaz video upscale experiment';
    frame.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture';
    frame.allowFullscreen = true;
    // YouTube requires an embedder identity; the site's default no-referrer can cause error 153.
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    frame.src = 'https://www.youtube-nocookie.com/embed/-U8jjMIlVU4?autoplay=1&playsinline=1&rel=0';
    frame.addEventListener('error', () => {
      if (frame.parentNode !== host) return;
      reset();
      status.textContent = 'The player could not load. Try again or watch directly on YouTube below.';
    });
    host.replaceChildren(frame);
    button.hidden = true;
    status.textContent = 'If playback does not start, use the direct YouTube link below.';
    frame.focus();
  });
  return reset;
}
