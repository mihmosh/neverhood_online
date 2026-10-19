import { discoverDemoRuntime } from '../lib/runtime.js';
import { demoAssetURL } from '../lib/demo-data.js';
import { initComparison } from './comparison.js';
import { initVideo } from './video.js';

const element = id => document.getElementById(id);
const page = element('demo-page');
const play = element('demo-play');
const playLabel = element('demo-play-label');
const status = element('demo-status');
const actions = element('demo-actions');
const recheck = element('demo-recheck');
const session = element('demo-session');
const host = element('demo-player-host');
const loading = element('demo-loading');
const loadingStatus = element('demo-loading-status');
const progress = element('demo-progress');
const cancel = element('demo-cancel');
const exit = element('demo-exit');
const fullscreen = element('demo-fullscreen');
const notice = element('demo-session-notice');
let runtime;
let controller;
let stopping = false;
let comparisonCleanup = initComparison({});
const resetVideo = initVideo();

function setStatus(text, error = false) {
  status.textContent = text;
  status.dataset.error = String(error);
}

async function checkAvailability() {
  play.disabled = true;
  recheck.hidden = true;
  actions.setAttribute('aria-busy', 'true');
  setStatus('Checking the demo...');
  try {
    const response = await fetch(new URL('./config.json', import.meta.url), { cache: 'no-store' });
    if (!response.ok) throw new Error('The demo configuration could not be loaded.');
    const config = await response.json();
    if (config.version !== 1 || (config.manifestURL !== null && (typeof config.manifestURL !== 'string' || !config.manifestURL.trim()))) {
      throw new Error('The demo configuration is not available in a supported format.');
    }
    const hostname = location.hostname;
    const loopback = hostname === 'localhost' || hostname.endsWith('.localhost') || /^127(?:\.\d{1,3}){3}$/.test(hostname) || hostname === '[::1]' || hostname === '::1';
    const manifestURL = config.manifestURL ?? (loopback ? '/__private-demo/manifest.json' : null);
    if (!manifestURL) {
      setStatus('This demo has not been published yet. In the meantime, you can bring your own game on the main page.');
      return;
    }
    comparisonCleanup?.();
    comparisonCleanup = initComparison({
      originalURL: demoAssetURL('room1-original-preview-v2.webp', new URL(manifestURL, location.href)),
      hdURL: demoAssetURL('room1-hd-preview-v2.webp', new URL(manifestURL, location.href)),
    });
    runtime = await discoverDemoRuntime({ manifestURL });
    if (!runtime.available) {
      setStatus(runtime.reason || 'The demo is not available right now. Please try again later.');
      recheck.hidden = false;
      return;
    }
    play.disabled = false;
    const size = Number.isSafeInteger(runtime.downloadBytes) && runtime.downloadBytes > 0 && runtime.downloadBytes < 1024 ** 3
      ? ` Up to ${Math.ceil(runtime.downloadBytes / 1024 ** 2)} MiB of game assets.` : '';
    setStatus(`Start in room 1; room 2 prepares in the background.${size}`);
  } catch (error) {
    runtime = null;
    setStatus(error.message || 'The demo could not be checked. Please try again.', true);
    recheck.hidden = false;
  } finally {
    actions.setAttribute('aria-busy', 'false');
  }
}

function stop() {
  if (!controller || stopping) return;
  stopping = true;
  exit.disabled = true;
  cancel.disabled = true;
  loading.hidden = false;
  element('demo-loading-title').textContent = 'Closing the demo';
  loadingStatus.textContent = 'Returning to the page...';
  progress.removeAttribute('value');
  controller.abort();
}

async function start() {
  if (controller || !runtime?.available) return;
  resetVideo();
  controller = new AbortController();
  const activeController = controller;
  let hasPlayed = false, waitingForRoom = false, startupProgress = 0;
  stopping = false;
  play.disabled = true;
  cancel.disabled = false;
  cancel.hidden = false;
  exit.disabled = false;
  loading.hidden = false;
  notice.hidden = true;
  element('demo-loading-title').textContent = 'Opening the first room';
  loadingStatus.textContent = 'Starting the demo...';
  progress.value = 0;
  const backgroundStatus = element('demo-background-status');
  backgroundStatus.textContent = '';
  backgroundStatus.hidden = true;
  session.hidden = false;
  page.inert = true;
  document.body.classList.add('demo-is-playing');
  exit.focus();
  try {
    await runtime.start({
      container: host,
      signal: controller.signal,
      onStatus(text, value, phase) {
        if (controller !== activeController || activeController.signal.aborted || stopping) return;
        const percent = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : undefined;
        if (phase === 'background') {
          backgroundStatus.hidden = false;
          backgroundStatus.textContent = `${text}${percent !== undefined && percent < 100 ? ` ${Math.floor(percent)}%` : ''}`;
          return;
        }
        if (phase === 'playing') {
          hasPlayed = true;
          waitingForRoom = false;
          progress.value = 100;
          loading.hidden = true;
          return;
        }
        if (phase === 'stopping') {
          loading.hidden = false;
          loadingStatus.textContent = text;
          progress.removeAttribute('value');
          cancel.hidden = true;
          element('demo-loading-title').textContent = 'Closing the demo';
          exit.disabled = true;
          return;
        }
        if (phase === 'room-loading') {
          if (!waitingForRoom) progress.value = 0;
          waitingForRoom = true;
          element('demo-loading-title').textContent = 'Preparing the next room';
          cancel.textContent = 'Exit demo';
          if (percent !== undefined) progress.value = Math.max(progress.value, percent);
        } else {
          if (hasPlayed) return;
          if (percent !== undefined) startupProgress = Math.max(startupProgress, percent);
          progress.value = startupProgress;
        }
        loading.hidden = false;
        loadingStatus.textContent = text;
        cancel.hidden = false;
      },
    });
    playLabel.textContent = 'Restart demo';
    setStatus(stopping ? 'Demo closed. You can start again whenever you like.' : 'Your little visit is over. Step inside again?');
  } catch (error) {
    if (controller.signal.aborted && error.name === 'AbortError') {
      playLabel.textContent = 'Play demo';
      setStatus('Demo cancelled. You can try again whenever you like.');
    } else {
      playLabel.textContent = 'Retry demo';
      setStatus(error.message || 'The demo could not start. Please try again.', true);
    }
  } finally {
    if (document.fullscreenElement === session) {
      try { await document.exitFullscreen(); } catch { /* The browser may already be leaving full screen. */ }
    }
    host.replaceChildren();
    backgroundStatus.hidden = true;
    cancel.textContent = 'Cancel loading';
    session.hidden = true;
    page.inert = false;
    document.body.classList.remove('demo-is-playing');
    controller = null;
    play.disabled = false;
    play.focus();
  }
}

play.addEventListener('click', start);
recheck.addEventListener('click', checkAvailability);
cancel.addEventListener('click', stop);
exit.addEventListener('click', stop);
fullscreen.hidden = !session.requestFullscreen;
fullscreen.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement === session) await document.exitFullscreen();
    else await session.requestFullscreen();
    notice.hidden = true;
  } catch {
    notice.textContent = 'Full screen is not available in this browser. You can keep playing here.';
    notice.hidden = false;
  }
});
document.addEventListener('fullscreenchange', () => {
  const active = document.fullscreenElement === session;
  fullscreen.setAttribute('aria-pressed', String(active));
  fullscreen.textContent = active ? 'Leave full screen' : 'Full screen';
});
session.addEventListener('keydown', event => {
  if (event.key !== 'Tab') return;
  const controls = [...session.querySelectorAll('button:not(:disabled), iframe')].filter(node => !node.hidden && node.getClientRects().length);
  const first = controls[0];
  const last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
});

checkAvailability();
