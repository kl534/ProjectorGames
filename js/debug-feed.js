// What a game's cameras see, sent to the debug view (debug.html) through the
// server's debug relay (debug-relay.js): a WebSocket the game keeps open, and
// sends on only while a debug view is connected, so a game nobody is watching
// does no extra work. Without the relay (a plain static server) it quietly
// tries again now and then.
//
// Messages are JSON ({type, …}; see ThrowCamera's publish* methods for what a
// game sends) or binary camera pictures (pictureMessage).

const RETRY_MS = 3000;
// Bytes waiting to go out, beyond which messages are dropped (the relay or the network is behind).
const MAX_BUFFERED = 1 << 20;
export const PICTURE_HEADER_BYTES = 8;

/**
 * A camera picture as a binary message: u8 camera, u8 unused, u16 width, u16 height, u16 unused (little-endian),
 * then the greyscale pixels, row by row.
 * @param {number} camera
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} pixels width × height
 */
export function pictureMessage(camera, width, height, pixels) {
  const out = new Uint8Array(PICTURE_HEADER_BYTES + width * height);
  const view = new DataView(out.buffer);
  view.setUint8(0, camera);
  view.setUint16(2, width, true);
  view.setUint16(4, height, true);
  out.set(pixels.subarray(0, width * height), PICTURE_HEADER_BYTES);
  return out;
}

/** The camera, size and pixels of a picture message (pictureMessage). */
export function readPicture(buffer) {
  const view = new DataView(buffer);
  const width = view.getUint16(2, true);
  const height = view.getUint16(4, true);
  return {
    camera: view.getUint8(0), width, height, pixels: new Uint8Array(buffer, PICTURE_HEADER_BYTES, width * height),
  };
}

/**
 * Numbers rounded for sending: 4 decimals is a tenth of a pixel on any camera, and keeps the messages short.
 * @param {object} value
 */
export function toJson(value) {
  return JSON.stringify(value, (_key, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1e4) / 1e4 : v));
}

/** The relay's address for a page served from `location`. */
export function relayUrl(location, role) {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/debug/ws?role=${role}`;
}

export class DebugFeed {
  /** @param {{url?: string, WebSocket?: typeof WebSocket}} [options] */
  constructor({ url = relayUrl(globalThis.location, 'game'), WebSocket: Socket = globalThis.WebSocket } = {}) {
    this.url = url;
    this.Socket = Socket;
    this.socket = null;
    this.viewers = 0;
    /** @type {Set<() => void>} called when a debug view connects (to send it what it missed) */
    this.onViewer = new Set();
    /** @type {object|null} the game's camera that is running (ThrowCamera), which alone sends its cameras */
    this.active = null;
    this.connect();
  }

  /** Whether anything sent now would reach a debug view. */
  get watched() {
    return this.viewers > 0 && this.socket?.readyState === 1;
  }

  connect() {
    if (typeof this.Socket !== 'function') return;
    let socket;
    try {
      socket = new this.Socket(this.url);
    } catch {
      return;
    }
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    socket.addEventListener('message', (e) => {
      if (typeof e.data !== 'string') return;
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === 'peers') {
        const before = this.viewers;
        this.viewers = msg.viewers;
        if (msg.viewers > before) for (const f of this.onViewer) f();
      } else if (msg.type === 'hello') {
        for (const f of this.onViewer) f();
      }
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.viewers = 0;
      setTimeout(() => this.connect(), RETRY_MS);
    });
  }

  /** Sends a message (an object, as JSON, or bytes) if a debug view is watching. */
  send(message) {
    if (!this.watched || this.socket.bufferedAmount > MAX_BUFFERED) return;
    this.socket.send(message instanceof Uint8Array ? message : toJson(message));
  }
}

let shared = null;
/** The page's one feed, opened the first time it is asked for. */
export function debugFeed() {
  shared ??= new DebugFeed();
  return shared;
}
