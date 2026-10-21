(() => {
  const videos = [...document.querySelectorAll('video')];
  if (!videos.length || document.getElementById('animation-controls')) return;
  const controls = document.createElement('div');
  controls.id = 'animation-controls';
  controls.style.cssText = 'display:flex;align-items:center;flex-wrap:wrap;gap:12px;padding:14px 0;position:sticky;top:0;background:#181818;z-index:10';
  const button = document.createElement('button');
  button.type = 'button';
  button.style.cssText = 'font:bold 18px system-ui;padding:12px 20px;color:#111;background:#f5cf77;border:0;border-radius:6px;min-width:180px;cursor:pointer';
  const restart = document.createElement('button');
  restart.type = 'button';
  restart.textContent = 'Restart';
  restart.style.cssText = 'font:18px system-ui;padding:10px 16px;cursor:pointer';
  const status = document.createElement('span');
  status.setAttribute('role', 'status');
  controls.append(button, restart);
  const selector = document.querySelector('select');
  if (selector) {
    const label = document.querySelector(`label[for="${selector.id}"]`);
    if (label) controls.append(label);
    controls.append(selector);
  }
  controls.append(status);
  (document.querySelector('h1') || document.body.firstElementChild).after(controls);
  const notes = [...document.querySelectorAll('body > p[id]')];
  if (notes.length) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Method, settings and limitations';
    details.append(summary, ...notes);
    controls.after(details);
  }
  let wanted = true;
  const active = () => videos.find(video => video.getClientRects().length) || videos[0];
  function update() {
    const video = active();
    button.textContent = video.paused ? 'Play animation' : 'Pause animation';
    button.setAttribute('aria-pressed', String(!video.paused));
    status.textContent = video.paused ? 'Paused. Press Play to animate.' : 'Playing in a loop';
  }
  async function play() {
    if (!wanted) return update();
    try { await active().play(); } catch { /* The visible Play button handles browser autoplay restrictions. */ }
    update();
  }
  for (const video of videos) {
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.loop = true;
    video.addEventListener('play', update);
    video.addEventListener('pause', update);
    video.addEventListener('canplay', () => { if (video === active()) play(); });
  }
  button.addEventListener('click', () => {
    wanted = active().paused;
    if (wanted) play(); else { active().pause(); update(); }
  });
  restart.addEventListener('click', () => { active().currentTime = 0; wanted = true; play(); });
  selector?.addEventListener('change', () => { for (const video of videos) if (video !== active()) video.pause(); play(); });
  update();
  play();
})();
