// Cameras read by ffmpeg through the server (native/feed.js), as the page sees
// them: Chrome on Windows delivers no more than about 62 frames a second from a
// camera, so a fast camera is also offered this way, at its full speed.
//
// Each one is a camera like any other to the rest of the app: `nativeMediaDevices`
// works like navigator.mediaDevices (enumerateDevices, getUserMedia), and the
// track it gives (a MediaStreamTrackGenerator fed with the server's frames) has
// the usual getSettings, getCapabilities and applyConstraints, which read and
// set the camera's exposure, white balance and focus through the server. So
// the preview, calibration, detection and holding the exposure all work on it
// unchanged. Its deviceId starts with NATIVE_PREFIX.
//
// Exposure is given as exposureTime in units of 100 Âµs, as Chrome on Windows
// does; the camera itself takes whole steps of log2 seconds (-7 is 1/128 s).

export const NATIVE_PREFIX = 'native:';
const HEADER_BYTES = 16;
// The camera's own settings and how they appear on a track.
const CONTROLS = [
  { name: 'exposure', mode: 'exposureMode', value: 'exposureTime' },
  { name: 'whiteBalance', mode: 'whiteBalanceMode', value: 'colorTemperature' },
  { name: 'focus', mode: 'focusMode', value: 'focusDistance' },
];

/** Whether a deviceId is one of these cameras. */
export function isNativeId(deviceId) {
  return typeof deviceId === 'string' && deviceId.startsWith(NATIVE_PREFIX);
}

/** exposureTime (100 Âµs units) for a DirectShow exposure step (log2 seconds), and back. */
export function exposureTimeOf(step) {
  return 2 ** step * 10000;
}

export function exposureStepOf(time) {
  return Math.round(Math.log2(time / 10000));
}

/**
 * Splits the server's stream into frames: each a 16-byte header (u32 width,
 * u32 height, f64 time in Âµs) and width Ã— height greyscale bytes. Chunks may
 * end anywhere.
 */
export class FrameReader {
  constructor() {
    this.buffer = new Uint8Array(1 << 20);
    this.length = 0;
  }

  /**
   * @param {Uint8Array} chunk
   * @returns {{width: number, height: number, timeUs: number, pixels: Uint8Array}[]} the frames it completes;
   *   their pixels are only good until the next push
   */
  push(chunk) {
    if (this.length + chunk.length > this.buffer.length) {
      const bigger = new Uint8Array(Math.max(this.buffer.length * 2, this.length + chunk.length));
      bigger.set(this.buffer.subarray(0, this.length));
      this.buffer = bigger;
    }
    this.buffer.set(chunk, this.length);
    this.length += chunk.length;
    const frames = [];
    let at = 0;
    while (this.length - at >= HEADER_BYTES) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + at, HEADER_BYTES);
      const width = view.getUint32(0, true);
      const height = view.getUint32(4, true);
      const timeUs = view.getFloat64(8, true);
      const end = at + HEADER_BYTES + width * height;
      if (end > this.length) break;
      frames.push({ width, height, timeUs, pixels: this.buffer.slice(at + HEADER_BYTES, end) });
      at = end;
    }
    if (at > 0) {
      this.buffer.copyWithin(0, at, this.length);
      this.length -= at;
    }
    return frames;
  }
}

/**
 * What the server's controls look like on a track (see CONTROLS).
 * @param {object} controls as the server gives them: {exposure: {min, max, step, value, auto, canAuto, canManual}, â€¦}
 * @returns {{settings: object, capabilities: object}}
 */
export function trackControls(controls) {
  const settings = {};
  const capabilities = {};
  for (const { name, mode, value } of CONTROLS) {
    const c = controls?.[name];
    if (!c || !Number.isFinite(c.value)) continue;
    const modes = [...(c.canAuto ? ['continuous'] : []), ...(c.canManual ? ['manual'] : [])];
    if (!modes.length) continue;
    capabilities[mode] = modes;
    settings[mode] = c.auto ? 'continuous' : 'manual';
    if (name === 'exposure') {
      capabilities[value] = { min: exposureTimeOf(c.min), max: exposureTimeOf(c.max), step: exposureTimeOf(c.min) };
      settings[value] = exposureTimeOf(c.value);
    } else {
      capabilities[value] = { min: c.min, max: c.max, step: c.step || 1 };
      settings[value] = c.value;
    }
  }
  return { settings, capabilities };
}

/**
 * What a track's constraints ask of the camera's controls (the last word on each wins, as in `advanced`):
 * for each control, 'auto', a value (in the camera's own units), or nothing.
 * @param {MediaTrackConstraints} constraints
 * @param {object} settings the track's settings now (see trackControls)
 * @returns {{control: string, value: string}[]}
 */
export function controlChanges(constraints, settings) {
  const asked = {};
  for (const set of [constraints, ...(constraints?.advanced ?? [])]) {
    for (const key of Object.keys(set ?? {})) if (key !== 'advanced') asked[key] = set[key];
  }
  const changes = [];
  for (const { name, mode, value } of CONTROLS) {
    if (!(mode in settings)) continue;
    const wantMode = typeof asked[mode] === 'string' ? asked[mode] : settings[mode];
    const wantValue = Number.isFinite(asked[value]) ? asked[value] : settings[value];
    if (wantMode !== 'manual') {
      if (settings[mode] !== wantMode) changes.push({ control: name, value: 'auto' });
      continue;
    }
    const step = name === 'exposure' ? exposureStepOf(wantValue) : Math.round(wantValue);
    const now = name === 'exposure' ? exposureStepOf(settings[value]) : settings[value];
    if (settings[mode] !== 'manual' || step !== now) changes.push({ control: name, value: String(step) });
  }
  return changes;
}

/**
 * Where the server is (the page's own address), and how to ask it.
 * @param {{fetch?: typeof fetch, base?: string}} [options]
 */
export function createNativeCameras({ fetch = globalThis.fetch?.bind(globalThis), base = '/native/' } = {}) {
  let listed = null;

  /** @returns {Promise<{id: string, name: string, formats: {width:number, height:number, fps:number, codec:string}[]}[]>} */
  function cameras(fresh = false) {
    if (!listed || fresh) {
      listed = (async () => {
        try {
          const res = await fetch(`${base}cameras${fresh ? '?fresh' : ''}`);
          const body = res.ok ? await res.json() : null;
          return body?.available ? body.cameras : [];
        } catch {
          return []; // no server feed (e.g. a plain static server): browser cameras only
        }
      })();
    }
    return listed;
  }

  async function cameraOf(deviceId) {
    const id = isNativeId(deviceId) ? deviceId.slice(NATIVE_PREFIX.length) : null;
    return (await cameras()).find((c) => c.id === id) ?? null;
  }

  async function readControls(id) {
    try {
      const res = await fetch(`${base}controls?id=${encodeURIComponent(id)}`);
      const body = await res.json();
      return body && !body.error ? body : {};
    } catch {
      return {};
    }
  }

  async function setControl(id, control, value) {
    const res = await fetch(`${base}controls?id=${encodeURIComponent(id)}&control=${control}&value=${encodeURIComponent(value)}`, { method: 'POST' });
    const body = await res.json();
    if (!res.ok || body?.error) throw new Error(body?.error || `couldnâ€™t set ${control}`);
    return body;
  }

  /** @param {MediaStreamConstraints} constraints */
  async function getUserMedia(constraints) {
    const video = typeof constraints?.video === 'object' ? constraints.video : {};
    const deviceId = video.deviceId?.exact ?? video.deviceId;
    const camera = await cameraOf(deviceId);
    if (!camera) throw domError('NotFoundError', 'no such camera');
    if (typeof MediaStreamTrackGenerator !== 'function' || typeof VideoFrame !== 'function') {
      throw domError('NotSupportedError', 'this browser canâ€™t make a camera track');
    }
    const ideal = (c) => (typeof c === 'number' ? c : c?.ideal ?? c?.exact);
    const want = { width: ideal(video.width), height: ideal(video.height), frameRate: ideal(video.frameRate) };
    const abort = new AbortController();
    let res;
    try {
      res = await fetch(`${base}stream?id=${encodeURIComponent(camera.id)}&width=${want.width ?? ''}&height=${want.height ?? ''}&fps=${want.frameRate ?? ''}`,
        { signal: abort.signal, cache: 'no-store' });
    } catch (err) {
      throw domError('NotReadableError', String(err?.message || err));
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw domError(res.status === 404 ? 'NotFoundError' : 'NotReadableError', body.error || 'the camera could not be started');
    }
    const mode = {
      width: Number(res.headers.get('X-Camera-Width')),
      height: Number(res.headers.get('X-Camera-Height')),
      frameRate: Number(res.headers.get('X-Camera-Fps')),
    };
    const controls = trackControls(await readControls(camera.id));
    const track = makeTrack({ camera, deviceId, mode, controls, abort, setControl, readControls });
    feed(res.body.getReader(), track);
    return new MediaStream([track]);
  }

  return {
    cameras,
    getUserMedia,
    /** Like navigator.mediaDevices.enumerateDevices, for these cameras. */
    async enumerateDevices() {
      return (await cameras()).map((c) => ({
        kind: 'videoinput', deviceId: NATIVE_PREFIX + c.id, label: `${c.name} (fast, via ffmpeg)`, groupId: '',
      }));
    },
    /** Every size a camera has, the largest first: findCameraModes tries these instead of guessing. */
    async modeSizes(deviceId) {
      const camera = await cameraOf(deviceId);
      if (!camera) return null;
      const sizes = [];
      for (const f of camera.formats) if (!sizes.some(([w, h]) => w === f.width && h === f.height)) sizes.push([f.width, f.height]);
      return sizes;
    },
    /** Opens the camera driver's own settings dialog (on the computer running the server); resolves when it is closed. */
    async openDriverSettings(deviceId) {
      const camera = await cameraOf(deviceId);
      if (!camera) return false;
      const res = await fetch(`${base}dialog?id=${encodeURIComponent(camera.id)}`, { method: 'POST' });
      return res.ok;
    },
  };
}

function domError(name, message) {
  const err = new Error(message);
  err.name = name;
  return err;
}

/** A camera track fed from the server's stream, with its settings and controls. */
function makeTrack({ camera, deviceId, mode, controls, abort, setControl, readControls }) {
  const track = new MediaStreamTrackGenerator({ kind: 'video' });
  let settings = { ...controls.settings };
  let capabilities = { ...controls.capabilities };
  let constraints = {};
  let ended = false;
  const stop = track.stop.bind(track);
  const finish = (fire) => {
    if (ended) return;
    ended = true;
    abort.abort();
    stop();
    if (fire) track.dispatchEvent(new Event('ended'));
  };
  Object.defineProperties(track, {
    label: { value: camera.name },
    readyState: { get: () => (ended ? 'ended' : 'live') },
  });
  Object.assign(track, {
    native: true,
    getSettings: () => ({
      deviceId, width: mode.width, height: mode.height, frameRate: mode.frameRate, resizeMode: 'none', ...settings,
    }),
    getCapabilities: () => ({
      deviceId,
      width: { min: 1, max: Math.max(...camera.formats.map((f) => f.width)) },
      height: { min: 1, max: Math.max(...camera.formats.map((f) => f.height)) },
      frameRate: { min: 0, max: Math.max(...camera.formats.map((f) => f.fps)) },
      ...capabilities,
    }),
    getConstraints: () => constraints,
    async applyConstraints(next = {}) {
      constraints = next;
      for (const { control, value } of controlChanges(next, settings)) {
        const fresh = trackControls(await setControl(camera.id, control, value));
        settings = fresh.settings;
        capabilities = fresh.capabilities;
      }
    },
    /** Reads the camera's controls again (they may have been changed in its own settings dialog). */
    async refreshControls() {
      const fresh = trackControls(await readControls(camera.id));
      settings = fresh.settings;
      capabilities = fresh.capabilities;
    },
    stop: () => finish(false),
  });
  track.finish = finish;
  return track;
}

/** Writes the server's frames to the track, until either ends. */
async function feed(reader, track) {
  const writer = track.writable.getWriter();
  const frames = new FrameReader();
  let i420 = null;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const f of frames.push(value)) {
        const size = f.width * f.height;
        if (i420?.length !== size * 1.5) i420 = new Uint8Array(size * 1.5).fill(128); // grey: no colour
        i420.set(f.pixels);
        // The track closes each frame once it is passed on.
        writer.write(new VideoFrame(i420, {
          format: 'I420', codedWidth: f.width, codedHeight: f.height, timestamp: f.timeUs,
        })).catch(() => {});
      }
      if (track.readyState === 'ended') break;
    }
  } catch {
    // stopped (aborted) or the server went away
  }
  writer.close().catch(() => {});
  // The camera went away by itself (unplugged, the server stopped): as when a camera is disconnected.
  track.finish(true);
}

/** The cameras of the server this page came from. */
export const nativeCameras = createNativeCameras();
