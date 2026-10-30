// Simple sound effects, generated with the Web Audio API (no sound files).

let ctx = null;

/** Browsers only allow sound after a click or key press: call this from one. */
export function unlockAudio() {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') ctx.resume();
  } catch {
    ctx = null; // no audio available; sounds are skipped
  }
}

/** A short low "thud", like a ball hitting a wall. */
export function playThud() {
  if (!ctx || ctx.state !== 'running') return;
  const t = ctx.currentTime;

  // Body: a quick downward pitch sweep.
  const osc = ctx.createOscillator();
  const body = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(170, t);
  osc.frequency.exponentialRampToValueAtTime(45, t + 0.18);
  body.gain.setValueAtTime(0.9, t);
  body.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
  osc.connect(body).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.26);

  // Impact: a short burst of muffled noise.
  const length = Math.floor(ctx.sampleRate * 0.05);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length);
  const noise = ctx.createBufferSource();
  noise.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 900;
  const click = ctx.createGain();
  click.gain.value = 0.5;
  noise.connect(filter).connect(click).connect(ctx.destination);
  noise.start(t);
}

/** A note: pitch in Hz, start offset and length in seconds. */
function tone(freq, { at = 0, length = 0.2, type = 'sine', volume = 0.4 } = {}) {
  const t = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(volume, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + length + 0.02);
}

const ready = () => ctx && ctx.state === 'running';

/**
 * A bright "ding" for hitting a target: higher and fuller for the better rings.
 * @param {number} level 0 for the outer ring, up to 2 for the centre
 */
export function playDing(level) {
  if (!ready()) return;
  const base = [660, 880, 1175][Math.min(2, Math.max(0, level))];
  tone(base, { length: 0.45, type: 'triangle', volume: 0.35 });
  tone(base * 2, { length: 0.25, volume: 0.12 });
  if (level >= 2) tone(base * 1.5, { at: 0.08, length: 0.4, type: 'triangle', volume: 0.25 });
}

/** Countdown beep; the last one ("Go!") is higher and longer. */
export function playBeep(go = false) {
  if (!ready()) return;
  tone(go ? 1046 : 523, { length: go ? 0.5 : 0.18, type: 'square', volume: 0.15 });
}

/** A short tick for the last seconds of a round. */
export function playTick() {
  if (!ready()) return;
  tone(1400, { length: 0.06, type: 'square', volume: 0.08 });
}

/** End of the round: a little rising fanfare. */
export function playFanfare() {
  if (!ready()) return;
  [523, 659, 784, 1046].forEach((f, i) => {
    tone(f, { at: i * 0.13, length: i === 3 ? 0.7 : 0.18, type: 'triangle', volume: 0.3 });
  });
}

/** A balloon popping: a sharp crack of bright noise. A big one (gold, Start) adds a sparkle. */
export function playPop(big = false) {
  if (!ready()) return;
  const t = ctx.currentTime;
  const length = Math.floor(ctx.sampleRate * 0.12);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 4;
  const noise = ctx.createBufferSource();
  noise.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = 1200;
  const gain = ctx.createGain();
  gain.gain.value = 0.9;
  noise.connect(filter).connect(gain).connect(ctx.destination);
  noise.start(t);
  if (big) {
    tone(1568, { at: 0.04, length: 0.3, type: 'triangle', volume: 0.2 });
    tone(2093, { at: 0.1, length: 0.35, type: 'triangle', volume: 0.15 });
  }
}

/** A balloon floating away: a soft, rising whistle. */
export function playEscape() {
  if (!ready()) return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(500, t);
  osc.frequency.exponentialRampToValueAtTime(1300, t + 0.6);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.25, t + 0.05);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.72);
}

/** A burst of noise: `seconds` long, fading out at the given `power` (higher fades faster). */
function noiseBurst(seconds, power) {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** power;
  const noise = ctx.createBufferSource();
  noise.buffer = buffer;
  return noise;
}

/** A brick smashing: crunchy noise over a low thump. */
export function playSmash() {
  if (!ready()) return;
  const t = ctx.currentTime;
  const crunch = noiseBurst(0.22, 3);
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 1800;
  filter.Q.value = 0.6;
  const crunchGain = ctx.createGain();
  crunchGain.gain.value = 0.9;
  crunch.connect(filter).connect(crunchGain).connect(ctx.destination);
  crunch.start(t);

  const thump = ctx.createOscillator();
  const thumpGain = ctx.createGain();
  thump.type = 'sine';
  thump.frequency.setValueAtTime(140, t);
  thump.frequency.exponentialRampToValueAtTime(40, t + 0.15);
  thumpGain.gain.setValueAtTime(0.8, t);
  thumpGain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
  thump.connect(thumpGain).connect(ctx.destination);
  thump.start(t);
  thump.stop(t + 0.22);
}

/** A brick cracking but holding: a short, dry click. */
export function playCrack() {
  if (!ready()) return;
  const click = noiseBurst(0.04, 2);
  const filter = ctx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = 2500;
  const gain = ctx.createGain();
  gain.gain.value = 0.7;
  click.connect(filter).connect(gain).connect(ctx.destination);
  click.start(ctx.currentTime);
}

/** An explosion: a low, rumbling burst of noise. */
export function playBoom() {
  if (!ready()) return;
  const t = ctx.currentTime;
  const rumble = noiseBurst(0.6, 2);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(900, t);
  filter.frequency.exponentialRampToValueAtTime(120, t + 0.55);
  const gain = ctx.createGain();
  gain.gain.value = 1.2;
  rumble.connect(filter).connect(gain).connect(ctx.destination);
  rumble.start(t);

  const low = ctx.createOscillator();
  const lowGain = ctx.createGain();
  low.type = 'sine';
  low.frequency.setValueAtTime(70, t);
  low.frequency.exponentialRampToValueAtTime(30, t + 0.4);
  lowGain.gain.setValueAtTime(0.7, t);
  lowGain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
  low.connect(lowGain).connect(ctx.destination);
  low.start(t);
  low.stop(t + 0.47);
}

/** A wall cleared: a short rising run of notes. */
export function playLevelClear() {
  if (!ready()) return;
  [523, 659, 784, 1046, 1319].forEach((f, i) => {
    tone(f, { at: i * 0.09, length: i === 4 ? 0.6 : 0.15, type: 'triangle', volume: 0.28 });
  });
}

/** The foreman's whistle: a shrill, warbling note, for the start and the end. */
export function playWhistle() {
  if (!ready()) return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(2700, t);
  osc.frequency.linearRampToValueAtTime(3000, t + 0.25);
  // A pea in the whistle makes the note warble.
  const wobble = ctx.createOscillator();
  const depth = ctx.createGain();
  wobble.frequency.value = 38;
  depth.gain.value = 90;
  wobble.connect(depth).connect(osc.frequency);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
  gain.gain.setValueAtTime(0.22, t + 0.38);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  wobble.start(t);
  osc.stop(t + 0.47);
  wobble.stop(t + 0.47);
}

/**
 * A slab of wall coming down: a low rumble that grows with the size of the slab
 * (0 small, 1 huge), then crumbling grit.
 */
export function playRumble(size = 0.5) {
  if (!ready()) return;
  const t = ctx.currentTime;
  const length = 0.35 + 0.5 * size;
  const rumble = noiseBurst(length, 1.2);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(500 + 500 * size, t);
  filter.frequency.exponentialRampToValueAtTime(90, t + length);
  const gain = ctx.createGain();
  gain.gain.value = 0.9 + 0.5 * size;
  rumble.connect(filter).connect(gain).connect(ctx.destination);
  rumble.start(t);

  // Grit tumbling after the first crash.
  const grit = noiseBurst(0.3 + 0.3 * size, 3);
  const high = ctx.createBiquadFilter();
  high.type = 'bandpass';
  high.frequency.value = 1400;
  high.Q.value = 0.5;
  const gritGain = ctx.createGain();
  gritGain.gain.value = 0.35;
  grit.connect(high).connect(gritGain).connect(ctx.destination);
  grit.start(t + 0.08);

  const low = ctx.createOscillator();
  const lowGain = ctx.createGain();
  low.type = 'sine';
  low.frequency.setValueAtTime(95, t);
  low.frequency.exponentialRampToValueAtTime(28, t + length);
  lowGain.gain.setValueAtTime(0.7, t);
  lowGain.gain.exponentialRampToValueAtTime(0.001, t + length);
  low.connect(lowGain).connect(ctx.destination);
  low.start(t);
  low.stop(t + length + 0.02);
}
