// Where a spot in a camera's picture is on the screen (on the wall's plane, normalised screen coords), and
// back. A webcam that sees the projected picture has a homography for it, from the flashing-corner
// calibration. An IR camera can't see the picture: it is measured instead (its lens, and where it is in the
// room, rig.js), and a spot is where its sight line meets the wall. The detector and the tracker only ever ask
// a CameraMap, so they work the same for both. Works on numbers only (no browser code), so it is unit tested.

import { applyHomography, fitHomography, invertHomography } from './homography.js';
import { projectToCamera, rayThrough } from './stereo.js';

/**
 * @typedef {{x:number, y:number}} Point
 * @typedef {object} CameraMap
 * @property {(p: Point) => Point} toScreen a camera spot (normalised camera coords) on the screen; NaN where its
 *   sight line never meets the wall
 * @property {(s: Point) => Point|null} toCamera a screen point in the camera's picture; null where it can't be
 * @property {number[]} cameraToScreen the homography that does the same (exactly, or nearest over the screen),
 *   for what only needs it roughly (drawing the outline in the debug view)
 * @property {boolean} seesPicture whether the camera sees the projected picture (an IR camera doesn't, so the
 *   game's own changes to it are no concern of its detector)
 */

/** A camera that sees the picture, with its calibration's homography. */
export function homographyMap(cameraToScreen) {
  const screenToCamera = invertHomography(cameraToScreen);
  return {
    toScreen: (p) => applyHomography(cameraToScreen, p),
    toCamera: (s) => (screenToCamera ? applyHomography(screenToCamera, s) : null),
    cameraToScreen,
    seesPicture: true,
  };
}

/**
 * A measured camera (stereo.js's CameraModel, room coordinates, with its lens): a spot is where its sight line
 * meets the wall (Z = 0), straightened by the lens.
 * @param {import('./stereo.js').CameraModel} model
 * @param {number} screenAspect the picture's height / width
 * @param {{seesPicture?: boolean}} [opts]
 * @returns {CameraMap}
 */
export function modelMap(model, screenAspect, { seesPicture = false } = {}) {
  const toScreen = (p) => {
    const { origin, dir } = rayThrough(model, p);
    if (!(dir.z > 1e-9)) return { x: NaN, y: NaN };
    const s = -origin.z / dir.z;
    return { x: origin.x + s * dir.x, y: (origin.y + s * dir.y) / screenAspect };
  };
  const toCamera = (s) => projectToCamera(model, { x: s.x, y: s.y * screenAspect, z: 0 });
  // The nearest homography over the screen and a margin round it.
  const screen = [];
  const camera = [];
  for (let i = -1; i <= 5; i++) {
    for (let j = -1; j <= 5; j++) {
      const s = { x: i / 4, y: j / 4 };
      const c = toCamera(s);
      if (c && Number.isFinite(c.x) && Number.isFinite(c.y)) { screen.push(s); camera.push(c); }
    }
  }
  const cameraToScreen = fitHomography(camera, screen) ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
  return { toScreen, toCamera, cameraToScreen, seesPicture };
}

/** A camera's map: the one given, or its homography's. */
export function mapOf({ map = null, cameraToScreen = null }) {
  return map ?? homographyMap(cameraToScreen);
}
