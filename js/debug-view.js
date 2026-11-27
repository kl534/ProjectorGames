// The debug view (debug.html): connects to the server's debug relay
// (debug-relay.js) as a viewer and shows what the game in another window
// sends (debug-feed.js, ThrowCamera's publish* methods): each camera's
// picture as the detector saw it, with the screen, the moving things (blobs),
// the paths being followed, the person zone and the hits drawn on it; each
// camera's numbers (frame rate, how late frames are looked at, each path's
// speed and direction); and every hit and throw the tracker reports.
//
// With "raw native feed", a camera read by the server (native/feed.js) is shown
// from its own stream instead, at full speed, by looking on at it (stream?watch)
// alongside the game, which keeps its own connection.

import { readPicture, relayUrl } from './debug-feed.js';
import {
  num, pathMotion, throwSummary, widthsToMph,
} from './debug-view-logic.js';
import { applyHomography, invertHomography } from './homography.js';
import { FrameReader } from './native-camera.js';

const RETRY_MS = 2000;
// How long a hit stays drawn on a camera's picture (ms).
const HIT_SHOWN_MS = 2000;
// The most hits and throws kept in the logs.
const MAX_LOG = 60;
// How long the paths' trails stay after a path ends (ms).
const TRAIL_MS = 1500;

const el = (id) => document.getElementById(id);
const ui = {
  relay: el('relay'),
  game: el('game'),
  note: el('note'),
  cameras: el('cameras'),
  hits: el('hits'),
  throws: el('throws'),
  lastThrow: el('last-throw'),
  pause: el('pause'),
  raw: el('raw'),
  trails: el('trails'),
  clear: el('clear'),
};

let paused = false;
/** The game's last 'cameras' message. */
let setup = null;
let games = 0;
let connected = false;
/** @type {Map<number, Panel>} */
const panels = new Map();

/**
 * @typedef {object} Panel one camera's part of the page and what it has been sent
 * @property {object} info its entry in the 'cameras' message
 * @property {HTMLElement} root
 * @property {HTMLCanvasElement} canvas
 * @property {HTMLElement} title
 * @property {HTMLElement} stats
 * @property {HTMLElement} verdict
 * @property {HTMLElement} pathRows
 * @property {HTMLElement} blobRows
 * @property {{width: number, height: number, pixels: Uint8Array}|null} picture from the game
 * @property {{width: number, height: number, pixels: Uint8Array}|null} rawPicture from the server's stream
 * @property {object|null} frame the last 'frame' message
 * @property {{x: number, y: number, at: number, reported?: boolean}[]} marks hits to draw (camera coords)
 * @property {{points: {x: number, y: number}[], at: number}[]} trails ended paths, still drawn a moment
 * @property {{frames: number, since: number, value: number}} rate frames from the game a second
 * @property {{frames: number, since: number, value: number}} rawRate raw frames a second
 * @property {AbortController|null} rawStream
 * @property {number[]|null} screenToCamera
 * @property {{x: number, y: number}|null} pointer the mouse over its picture (camera coords)
 * @property {boolean} dirty
 */

// ---- The relay ----

function connect() {
  const socket = new WebSocket(relayUrl(location, 'viewer'));
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('open', () => {
    connected = true;
    // Ask the game what it is running, in case it started before this view.
    socket.send(JSON.stringify({ type: 'hello' }));
    showStatus();
  });
  socket.addEventListener('message', (e) => {
    if (typeof e.data === 'string') onMessage(JSON.parse(e.data));
    else if (!paused) onPicture(readPicture(e.data));
  });
  socket.addEventListener('close', () => {
    connected = false;
    games = 0;
    showStatus();
    setTimeout(connect, RETRY_MS);
  });
}

function onMessage(msg) {
  if (msg.type === 'peers') {
    games = msg.games;
    showStatus();
    return;
  }
  if (msg.type === 'cameras') {
    setup = msg;
    syncPanels();
    showStatus();
    return;
  }
  if (paused) return;
  if (msg.type === 'frame') onFrame(msg);
  else if (msg.type === 'hit') onHit(msg);
  else if (msg.type === 'throw') onThrow(msg);
}

function showStatus() {
  ui.relay.textContent = connected ? 'relay: connected' : 'relay: not connected';
  ui.relay.className = `chip ${connected ? 'on' : 'off'}`;
  ui.game.textContent = games ? `game connected${games > 1 ? ` (${games})` : ''}` : 'no game';
  ui.game.className = `chip ${games ? 'on' : 'off'}`;
  const running = setup?.cameras?.length ?? 0;
  ui.note.textContent = !connected ? 'Can’t reach the debug relay: is this page served by npm start?'
    : !games ? 'Waiting for a game: start one in the other window (with a calibration, so its cameras run).'
      : !running ? 'The game has no camera running yet.'
        : `${setup.launch ? 'Launch mode. ' : ''}${setup.screenWidthFt ? `Screen ${setup.screenWidthFt} ft wide.` : 'Screen width not set in Setup: no mph.'}`;
}

// ---- Cameras ----

/** Makes a panel for each camera the game runs, and drops the rest. */
function syncPanels() {
  const wanted = new Map((setup?.cameras ?? []).map((c) => [c.camera, c]));
  for (const [index, panel] of panels) {
    if (wanted.has(index)) continue;
    panel.rawStream?.abort();
    panel.root.remove();
    panels.delete(index);
  }
  for (const [index, info] of wanted) {
    const panel = panels.get(index) ?? makePanel(index);
    panel.info = info;
    panel.screenToCamera = info.cameraToScreen ? invertHomography(info.cameraToScreen) : null;
    panel.title.textContent = `${info.label ?? info.deviceId ?? ''} · ${info.width}×${info.height}${info.frameRate ? ` @ ${Math.round(info.frameRate)}` : ''} · delay ${num(info.latencyMs, 0)} ms${info.upsideDown ? ' · upside down, shown turned round' : ''}`;
    panel.dirty = true;
    updateRawStream(panel);
  }
}

function makePanel(index) {
  const root = document.createElement('div');
  root.className = 'camera';
  root.innerHTML = `
    <h2>${index ? 'Second' : 'Main'} camera <small></small></h2>
    <canvas></canvas>
    <div class="stats"></div>
    <p class="verdict"></p>
    <div class="scroll"><table>
      <thead><tr><th>path</th><th>pts</th><th>ms</th><th>x</th><th>y</th><th>speed w/s</th><th>≈ mph</th><th>dir°</th><th>length w</th></tr></thead>
      <tbody class="paths"></tbody>
    </table></div>
    <div class="scroll"><table>
      <thead><tr><th>blob</th><th>x</th><th>y</th><th>area</th></tr></thead>
      <tbody class="blobs"></tbody>
    </table></div>`;
  // Main camera first.
  const after = [...panels.entries()].filter(([i]) => i > index).sort(([a], [b]) => a - b)[0];
  ui.cameras.insertBefore(root, after ? after[1].root : null);
  const panel = {
    info: null,
    root,
    canvas: root.querySelector('canvas'),
    title: root.querySelector('small'),
    stats: root.querySelector('.stats'),
    verdict: root.querySelector('.verdict'),
    pathRows: root.querySelector('.paths'),
    blobRows: root.querySelector('.blobs'),
    picture: null,
    rawPicture: null,
    frame: null,
    marks: [],
    trails: [],
    rate: { frames: 0, since: 0, value: 0 },
    rawRate: { frames: 0, since: 0, value: 0 },
    rawStream: null,
    screenToCamera: null,
    pointer: null,
    dirty: true,
  };
  panel.canvas.addEventListener('mousemove', (e) => {
    const box = panel.canvas.getBoundingClientRect();
    const x = (e.clientX - box.left) / box.width;
    const y = (e.clientY - box.top) / box.height;
    // Camera coords: a camera mounted upside down is drawn turned round.
    panel.pointer = panel.info?.upsideDown ? { x: 1 - x, y: 1 - y } : { x, y };
    panel.dirty = true;
  });
  panel.canvas.addEventListener('mouseleave', () => {
    panel.pointer = null;
    panel.dirty = true;
  });
  panels.set(index, panel);
  return panel;
}

function onPicture({ camera, width, height, pixels }) {
  const panel = panels.get(camera);
  if (!panel) return;
  panel.picture = { width, height, pixels: pixels.slice() };
  panel.dirty = true;
}

function onFrame(msg) {
  const panel = panels.get(msg.camera);
  if (!panel) return;
  const before = panel.frame;
  // Paths that have ended stay drawn a moment, so a quick throw can be seen.
  if (before) {
    for (const path of before.paths) {
      const head = path.at(-1);
      if (head && !msg.paths.some((p) => p.some((q) => q.t === head.t && q.x === head.x))) {
        panel.trails.push({ points: path, at: performance.now() });
      }
    }
  }
  panel.frame = msg;
  for (const h of msg.hits) panel.marks.push({ x: h.camera.x, y: h.camera.y, at: performance.now(), support: h.support });
  count(panel.rate, performance.now());
  panel.dirty = true;
}

/** Shows or stops a camera's raw stream from the server, as the checkbox and camera say. */
function updateRawStream(panel) {
  const want = ui.raw.checked && panel.info?.nativeId;
  if (!want) {
    panel.rawStream?.abort();
    panel.rawStream = null;
    panel.rawPicture = null;
    return;
  }
  if (panel.rawStream) return;
  const abort = new AbortController();
  panel.rawStream = abort;
  (async () => {
    while (!abort.signal.aborted) {
      try {
        const res = await fetch(`/native/stream?id=${encodeURIComponent(panel.info.nativeId)}&watch`, { signal: abort.signal, cache: 'no-store' });
        if (!res.ok) throw new Error(`${res.status}`);
        const reader = res.body.getReader();
        const frames = new FrameReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const got = frames.push(value);
          const f = got.at(-1);
          if (!f) continue;
          for (let i = 0; i < got.length; i++) count(panel.rawRate, performance.now());
          if (paused) continue;
          panel.rawPicture = { width: f.width, height: f.height, pixels: f.pixels };
          panel.dirty = true;
        }
      } catch {
        // stopped, or the server went away: try again below
      }
      if (!abort.signal.aborted) await new Promise((resolve) => { setTimeout(resolve, RETRY_MS); });
    }
  })();
}

function count(rate, now) {
  rate.frames++;
  if (now - rate.since >= 1000) {
    rate.value = Math.round((rate.frames * 1000) / (now - rate.since));
    rate.frames = 0;
    rate.since = now;
  }
}

// ---- Hits and throws ----

function onHit({ hit }) {
  // Where it hit, in each camera's picture.
  for (const panel of panels.values()) {
    if (!panel.screenToCamera) continue;
    const p = applyHomography(panel.screenToCamera, hit);
    panel.marks.push({ x: p.x, y: p.y, at: performance.now(), reported: true });
    panel.dirty = true;
  }
  const launch = hit.launch;
  const row = document.createElement('tr');
  const cells = [
    new Date().toLocaleTimeString(),
    num(hit.x, 3), num(hit.y, 3), hit.cameras?.join('+') ?? '–', num(hit.spread, 3),
    num(hit.speedMph, 1), num(hit.speed, 2), num(hit.towardWall, 2), num(hit.elevation, 1), hit.frames ?? '–',
    `${hit.spotFrom ?? ''}${hit.fromFlight ? ' (flight)' : ''}`,
    num(launch?.speedMph, 1), num(launch?.elevation, 1), num(launch?.azimuth, 1), launch?.from ?? '–',
  ];
  for (const text of cells) {
    const td = document.createElement('td');
    td.textContent = String(text);
    row.append(td);
  }
  ui.hits.prepend(row);
  while (ui.hits.children.length > MAX_LOG) ui.hits.lastChild.remove();
}

function onThrow({ throw: seen }) {
  const div = document.createElement('div');
  div.className = 'throw';
  const head = document.createElement('div');
  const r = seen.reported;
  head.textContent = `#${seen.id} · ${new Date().toLocaleTimeString()} · ${r ? `hit at ${num(r.x, 3)}, ${num(r.y, 3)}${r.speedMph ? ` · ${num(r.speedMph, 1)} mph` : ''}` : 'no hit reported'}`;
  const lines = document.createElement('div');
  lines.className = 'lines';
  lines.textContent = throwSummary(seen).join('\n');
  div.append(head, lines);
  ui.throws.prepend(div);
  while (ui.throws.children.length > MAX_LOG) ui.throws.lastChild.remove();
  ui.lastThrow.textContent = JSON.stringify(seen, null, 1);
}

// ---- Drawing ----

function draw() {
  const now = performance.now();
  for (const panel of panels.values()) {
    panel.marks = panel.marks.filter((m) => now - m.at < HIT_SHOWN_MS);
    panel.trails = panel.trails.filter((t) => now - t.at < TRAIL_MS);
    if (panel.marks.length || panel.trails.length) panel.dirty = true;
    if (!panel.dirty) continue;
    panel.dirty = false;
    drawPanel(panel, now);
    showNumbers(panel);
  }
  requestAnimationFrame(draw);
}

/** Grey pixels to a canvas of their own size, reused. */
const pictureCanvas = document.createElement('canvas');
function pictureOf({ width, height, pixels }) {
  if (pictureCanvas.width !== width || pictureCanvas.height !== height) {
    pictureCanvas.width = width;
    pictureCanvas.height = height;
  }
  const ctx = pictureCanvas.getContext('2d');
  const image = ctx.createImageData(width, height);
  const px = image.data;
  for (let i = 0, j = 0; i < width * height; i++, j += 4) {
    px[j] = px[j + 1] = px[j + 2] = pixels[i];
    px[j + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return pictureCanvas;
}

function drawPanel(panel, now) {
  const { canvas, info } = panel;
  const picture = (ui.raw.checked && panel.rawPicture) || panel.picture;
  const aspect = picture ? picture.height / picture.width : (info?.height / info?.width) || 0.75;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr) || 640;
  const h = Math.round(w * aspect);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  // A camera mounted upside down: everything in its coordinates drawn turned round, the right way up.
  const flipped = Boolean(info?.upsideDown);
  if (flipped) ctx.setTransform(-1, 0, 0, -1, w, h);
  if (picture) ctx.drawImage(pictureOf(picture), 0, 0, w, h);
  const s = dpr;
  const line = (points, colour, close = false, width = 1.5) => {
    if (points.length < 2) return;
    ctx.beginPath();
    points.forEach((p, i) => (i ? ctx.lineTo(p.x * w, p.y * h) : ctx.moveTo(p.x * w, p.y * h)));
    if (close) ctx.closePath();
    ctx.strokeStyle = colour;
    ctx.lineWidth = width * s;
    ctx.stroke();
  };
  if (info?.screenCornersCamera) line(info.screenCornersCamera, '#3ddc84', true);
  const f = panel.frame;
  if (f) {
    ctx.fillStyle = 'rgba(224, 96, 224, 0.18)';
    ctx.strokeStyle = '#e060e0';
    ctx.lineWidth = s;
    for (const b of f.people ?? []) {
      ctx.fillRect(b.x0 * w, b.y0 * h, (b.x1 - b.x0) * w, (b.y1 - b.y0) * h);
      ctx.strokeRect(b.x0 * w, b.y0 * h, (b.x1 - b.x0) * w, (b.y1 - b.y0) * h);
    }
    if (ui.trails.checked) {
      for (const t of panel.trails) {
        ctx.globalAlpha = 1 - (now - t.at) / TRAIL_MS;
        line(t.points, '#ffe066', false, 1);
      }
      ctx.globalAlpha = 1;
    }
    for (const path of f.paths) {
      line(path, '#ffe066');
      ctx.fillStyle = '#ffe066';
      for (const p of path) ctx.fillRect(p.x * w - s, p.y * h - s, 2 * s, 2 * s);
    }
    ctx.strokeStyle = '#6cc4ff';
    ctx.lineWidth = 1.5 * s;
    ctx.font = `${10 * s}px system-ui`;
    ctx.fillStyle = '#6cc4ff';
    for (const b of f.blobs) {
      const r = Math.max(4 * s, Math.sqrt(b.area) * (w / (info?.processWidth || 320)) * 0.7);
      ctx.beginPath();
      ctx.arc(b.x * w, b.y * h, r, 0, Math.PI * 2);
      ctx.stroke();
      // Its size, upright beside it.
      ctx.save();
      ctx.translate(b.x * w, b.y * h);
      if (flipped) ctx.rotate(Math.PI);
      ctx.fillText(String(b.area), r + 2 * s, -r);
      ctx.restore();
    }
  }
  for (const m of panel.marks) {
    ctx.globalAlpha = 1 - (now - m.at) / HIT_SHOWN_MS;
    ctx.strokeStyle = m.reported ? '#ffffff' : m.support ? '#ffb44a' : '#ff6060';
    ctx.lineWidth = 2 * s;
    const x = m.x * w;
    const y = m.y * h;
    const r = (m.reported ? 12 : 7) * s;
    ctx.beginPath();
    if (m.reported) {
      ctx.arc(x, y, r, 0, Math.PI * 2);
    } else {
      ctx.moveTo(x - r, y); ctx.lineTo(x + r, y);
      ctx.moveTo(x, y - r); ctx.lineTo(x, y + r);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (panel.pointer) {
    const p = panel.pointer;
    const scr = info?.cameraToScreen ? applyHomography(info.cameraToScreen, p) : null;
    const text = `cam ${num(p.x, 3)}, ${num(p.y, 3)}${scr ? ` · screen ${num(scr.x, 3)}, ${num(scr.y, 3)}` : ''}`;
    ctx.font = `${11 * s}px system-ui`;
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(4 * s, h - 20 * s, tw + 8 * s, 16 * s);
    ctx.fillStyle = '#fff';
    ctx.fillText(text, 8 * s, h - 8 * s);
  }
}

function showNumbers(panel) {
  const f = panel.frame;
  const info = panel.info;
  const stat = (label, value) => `<div><span>${label}</span> ${value}</div>`;
  const state = !f ? 'no frames yet' : f.sceneChange ? 'whole picture changed' : f.paths.length ? `following ${f.paths.length}` : 'waiting';
  panel.stats.innerHTML = [
    stat('camera', `${f?.fps ?? '–'} fps`),
    stat('sent', `${panel.rate.value} /s`),
    ui.raw.checked && info?.nativeId ? stat('raw', `${panel.rawRate.value} fps`) : '',
    stat('lag', num(f?.lagMs, 1, 'ms')),
    stat('work', num(f?.workMs, 2, 'ms')),
    stat('brightness', num(f?.brightness, 0)),
    stat('moving px', f?.changed ?? '–'),
    stat('blobs', f?.blobs.length ?? '–'),
    stat('people', f?.people?.length ?? '–'),
    stat('state', state),
    f?.held ? stat('holding', f.held) : '',
    f?.exposureNote ? stat('exposure', f.exposureNote) : '',
  ].join('');
  panel.verdict.textContent = f?.verdict ? `last path: ${f.verdict}` : '';
  const aspect = (info?.processHeight / info?.processWidth) || (info?.height / info?.width) || 0.75;
  panel.pathRows.innerHTML = (f?.paths ?? []).map((path, i) => {
    const m = pathMotion(path, aspect);
    if (!m) return '';
    return `<tr><td>${i + 1}</td><td>${m.points}</td><td>${num(m.durationMs, 0)}</td><td>${num(m.x, 3)}</td><td>${num(m.y, 3)}</td>`
      + `<td>${num(m.speed, 2)}</td><td>${num(widthsToMph(m.speed, setup?.screenWidthFt), 1)}</td><td>${num(m.angleDeg, 0)}</td><td>${num(m.length, 3)}</td></tr>`;
  }).join('');
  panel.blobRows.innerHTML = (f?.blobs ?? []).slice(0, 12).map((b, i) => `<tr><td>${i + 1}</td><td>${num(b.x, 3)}</td><td>${num(b.y, 3)}</td><td>${b.area}</td></tr>`).join('');
}

// ---- Controls ----

function togglePause() {
  paused = !paused;
  ui.pause.textContent = paused ? 'Resume' : 'Pause';
}

ui.pause.addEventListener('click', togglePause);
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target === document.body) {
    e.preventDefault();
    togglePause();
  }
});
ui.raw.addEventListener('change', () => {
  for (const panel of panels.values()) {
    updateRawStream(panel);
    panel.dirty = true;
  }
});
ui.trails.addEventListener('change', () => { for (const p of panels.values()) p.dirty = true; });
ui.clear.addEventListener('click', () => {
  ui.hits.replaceChildren();
  ui.throws.replaceChildren();
  ui.lastThrow.textContent = '–';
});

showStatus();
connect();
requestAnimationFrame(draw);
