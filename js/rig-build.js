// Building the IR rig from what the cameras saw, one Setup step at a time (docs/ir-calibration.md, steps 2–4),
// each with the checks the guide tells the user to look at: the cameras placed from the wall markers
// (placeCameras), refined together with the wand (refineCameras), the picture placed on the wall through a
// webcam that sees both (placePicture), each IR camera's delay from an LED both saw blink (irDelays), and the
// calibration the games use (rig.js's rigCalibration). Works on spots and frames, not pictures (no browser
// code), so it is unit tested end to end on the simulated room.

import { blinkDelay } from './ir-spots.js';
import { centreOf } from './lens.js';
import {
  matchMarkers, placeCamera, placeScreen, refineRig, rigCalibration, wandSamples, wellSpread,
} from './rig.js';

/**
 * @typedef {import('./rig.js').Marker} Marker
 * @typedef {import('./rig.js').RigCamera} RigCamera
 * @typedef {import('./lens.js').Lens} Lens
 * @typedef {{x:number, y:number, frames?:number, sigmaPixels?:number}} StillSpot SpotAverager's
 */

// How well the markers' places were measured with a tape (metres), and a blob's centre in one frame (pixels).
const TAPE_M = 0.002;
const SPOT_PIXELS = 0.3;
// Once the wand is in, markers landing further than this (pixels, RMS) from where they were seen mean the wand
// and the markers disagree about the room's size: half a percent, in the simulated room.
const MARKERS_DISAGREE_PIXELS = 0.45;

/**
 * Step 2: each IR camera placed from the markers it sees (its still spots, averaged over a second).
 * @param {object} args
 * @param {Marker[]} args.markers
 * @param {{lens: Lens, still: StillSpot[], width: number}[]} args.cameras each camera's measured lens, still
 *   spots and picture width (pixels)
 * @returns {{cameras: {placed: (RigCamera & {centre: object, centreSigma: number|null})|null, matched: (StillSpot|null)[],
 *   found: number, missing: string[], rmsPixels: number|null, problem: string|null}[], ok: boolean}} missing: the
 *   markers it couldn't see; problem: what to do about a camera that couldn't be placed
 */
export function placeCameras({ markers, cameras }) {
  const out = cameras.map(({ lens, still, width }) => {
    const found = matchMarkers(markers, still, { lens });
    if (!found) {
      return {
        placed: null, matched: markers.map(() => null), found: 0, missing: markers.map((m) => m.id), rmsPixels: null,
        problem: `It sees ${still.length} bright spot${still.length === 1 ? '' : 's'}, and couldn't match four of them to the markers. Check every marker is lit and in its picture, and that their places are entered right.`,
      };
    }
    const missing = markers.filter((m, i) => !found.matched[i]).map((m) => m.id);
    if (!wellSpread(markers.filter((m, i) => found.matched[i]))) {
      return {
        placed: null, matched: found.matched, found: found.found, missing, rmsPixels: null,
        problem: `It sees ${found.found} markers, but too nearly in a line to tell where it is${missing.length ? ` (not seen: ${missing.join(', ')})` : ''}. It needs four or more spread round the wall: move what hides the others, or add a marker.`,
      };
    }
    const placed = placeCamera(lens, markers, found.matched);
    return {
      placed,
      matched: found.matched,
      found: found.found,
      missing,
      rmsPixels: placed ? placed.rms * width : null,
      problem: placed ? null : 'Its markers matched, but no camera place fits them: check the markers\' places are entered right.',
    };
  });
  return { cameras: out, ok: out.every((c) => c.placed) };
}

/**
 * Step 3: both cameras refined together with the wand.
 * @param {object} args
 * @param {Marker[]} args.markers
 * @param {ReturnType<typeof placeCameras>['cameras']} args.placed step 2's
 * @param {import('./rig.js').WandFrame[][]} args.wand each camera's frames of the wand (its two moving spots)
 * @param {number} args.length the wand's length (metres)
 * @param {number} args.width picture width (pixels)
 * @returns {{cameras: RigCamera[], samples: number, lengthRms: number, lengthMean: number, wandRmsPixels: number,
 *   markerRmsPixels: number, markersSay: number|null, problem: string|null}|null} markersSay: how long the markers
 *   alone make the wand (metres), where they and the wand disagree; null if the wand wasn't seen by both cameras
 *   enough
 */
export function refineCameras({ markers, placed, wand, length, width }) {
  const samples = wandSamples(wand[0], wand[1]);
  if (samples.length < 20) return null;
  const cameras = placed.map((p) => p.placed);
  // A marker's averaged spot is as good as the tape its place was measured with, seen from where the camera is.
  const markerSigma = Math.max(...cameras.map((c) => {
    const from = centreOf(c.pose);
    const far = Math.max(...markers.map((m) => Math.hypot(m.at.x - from.x, m.at.y - from.y, m.at.z - from.z)));
    return Math.hypot(SPOT_PIXELS / Math.sqrt(30) / width, (TAPE_M / far) * c.lens.fx);
  }));
  const args = {
    cameras, markers, markerSpots: placed.map((p) => p.matched), wand: { length, samples },
    spotSigma: SPOT_PIXELS / width, markerSigma,
  };
  const refined = refineRig(args);
  if (!refined) return null;
  const mean = (values) => values.reduce((s, l) => s + l, 0) / values.length;
  const lengthMean = mean(refined.lengths);
  // The wand sets the room's size far more firmly than markers 20 ft away, so a wand measured wrong stretches
  // the whole rig (and every speed with it) while still fitting itself: but then the markers no longer land
  // where they were seen. Where they don't, the markers alone say how long the wand is.
  const markerRmsPixels = refined.markerRms * width;
  let markersSay = null;
  let problem = null;
  if (markerRmsPixels > MARKERS_DISAGREE_PIXELS) {
    const free = refineRig({ ...args, freeLength: true });
    markersSay = free ? mean(free.lengths) : null;
    problem = markersSay
      ? `The markers and the wand disagree about how big the room is: the markers make the wand ${Math.round(markersSay * 1000)} mm long, not ${Math.round(length * 1000)} mm. Measure the wand again, and check the markers' places.`
      : 'The markers no longer fit once the wand is in: check the wand\'s length and the markers\' places.';
  } else if (Math.abs(lengthMean - length) > 0.005) {
    problem = 'The wand comes out a different length on average than entered: check its length.';
  } else if (refined.wandRms * width > 1.5) {
    problem = 'The wand\'s ends don\'t fit well: wave it more slowly, and keep both ends in both cameras\' view.';
  }
  return {
    cameras: refined.cameras,
    samples: samples.length,
    lengthRms: refined.lengthRms,
    lengthMean,
    wandRmsPixels: refined.wandRms * width,
    markerRmsPixels,
    markersSay,
    problem,
  };
}

/**
 * Step 4: the picture placed on the wall by a webcam that sees both the markers and the projector (its usual
 * flashing-corner calibration).
 * @param {object} args
 * @param {Marker[]} args.markers
 * @param {StillSpot[]} args.still the webcam's still spots
 * @param {number[]} args.cameraToScreen its calibration's homography
 * @param {number} args.imageAspect its picture's height / width
 * @param {Lens|null} [args.lens] its lens, if measured
 * @returns {{screen: import('./rig.js').ScreenPlacement|null, found: number, problem: string|null}}
 */
export function placePicture({ markers, still, cameraToScreen, imageAspect, lens = null }) {
  const found = matchMarkers(markers, still, { lens, imageAspect });
  if (!found) {
    return { screen: null, found: 0, problem: 'The webcam couldn\'t match four of the markers: it must see them all, lit (a light next to it, for reflective dots).' };
  }
  const screen = placeScreen({ markers, spots: found.matched, cameraToScreen, lens });
  if (!screen) return { screen: null, found: found.found, problem: 'The picture couldn\'t be placed: calibrate the webcam again.' };
  const problem = screen.skew > 0.02
    ? `The picture is ${Math.round(screen.skew * 1000)} mm from a true rectangle at a corner: square it up with the projector's keystone, and run this again.`
    : null;
  return { screen, found: found.found, problem };
}

/**
 * Each IR camera's delay (how late it sees the room, plus the projector's: what the games call a camera's
 * delay), from the webcam's, measured with the flashing corners, and an LED all of them saw being covered and
 * uncovered: the webcam's delay is the projector's plus its own, and the blink says how much sooner or later
 * each IR camera sees the room than the webcam.
 * @param {{webcamLatencyMs: number, webcam: {t:number, lit:boolean}[], cameras: {t:number, lit:boolean}[][]}} args
 * @returns {{latencyMs: number[]|null, spreadMs: number[], problem: string|null}}
 */
export function irDelays({ webcamLatencyMs, webcam, cameras }) {
  const found = cameras.map((frames) => blinkDelay(webcam, frames));
  if (found.some((f) => !f)) {
    return { latencyMs: null, spreadMs: [], problem: 'Not every camera saw the LED go on and off: hold it where all the cameras see it, and cover and uncover it a few times.' };
  }
  return {
    latencyMs: found.map((f) => Math.max(0, webcamLatencyMs + f.delayMs)),
    spreadMs: found.map((f) => f.spreadMs),
    problem: null,
  };
}

/**
 * The calibration the games use, from the steps' results.
 * @param {object} args
 * @param {RigCamera[]} args.cameras step 3's (or step 2's placed cameras, without a wand)
 * @param {import('./rig.js').ScreenPlacement} args.screen step 4's
 * @param {{cameraId: string, cameraLabel: string, videoWidth: number, videoHeight: number,
 *   cameraMode?: import('./camera.js').CameraMode}[]} args.info each camera's
 * @param {number[]|null} [args.latencyMs] irDelays'
 */
export function rigFromSteps({ cameras, screen, info, latencyMs = null }) {
  return rigCalibration({
    cameras: cameras.map((camera, i) => ({
      camera: { lens: camera.lens, pose: camera.pose },
      ...info[i],
      ...(latencyMs ? { latencyMs: Math.round(latencyMs[i]) } : {}),
    })),
    screen,
  });
}
