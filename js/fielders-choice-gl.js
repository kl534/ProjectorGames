// Fielder's Choice's WebGL renderer: draws the ballpark and the players built
// in fielders-choice-models.js, through a view from fielders-choice-logic.js,
// with a depth buffer so everything hides what is behind it. It draws on a
// canvas of its own, off the page; the art copies each picture onto the
// game's canvases (the scene, the covering fielder, the runner), so the rest
// of the game (and the camera watching for throws) sees ordinary canvases.
//
// The look is a cartoon's: solids are lit in two flat tones (lit and shade)
// by the light towers, players have dark outlines (each shape drawn again a
// little bigger, inside out, in the outline colour), and the ground's mowing
// stripes and dirt are patterns worked out where they are on the field.

import {
  MATERIAL, STRIDE, boardFace, boxInView, buildCrowd, buildGround, buildSolids, projectionMatrix, signPanels, spriteMatrix,
  viewMatrix, Mesh, GLYPHS,
} from './fielders-choice-models.js';

const STATIC_VS = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec4 aColour;
layout(location = 3) in vec2 aUv;
layout(location = 4) in vec2 aMat;
uniform mat4 uView;
uniform mat4 uProj;
uniform vec4 uCrowd; // cheer (0–1, fading), groan (0–1), seconds since it started, unused
out vec3 vWorld;
out vec3 vNormal;
out vec4 vColour;
out vec2 vUv;
flat out int vMat;
void main() {
  vec3 p = aPos;
  if (aMat.y >= 1.0) {
    // Someone in the crowd: they bob as they cheer (some with their arms up), and slump in a groan.
    float hash = floor(fract(aMat.y) * 1000.0 + 0.5);
    float jump = max(0.0, sin(uCrowd.z * 11.0 + mod(hash, 13.0))) * 1.1 * uCrowd.x - 0.35 * uCrowd.y;
    p.z += jump;
    if (aMat.y >= 2.0 && uCrowd.x > 0.0 && mod(hash, 3.0) >= 1.0) p.z += 1.5 * min(1.0, uCrowd.x * 4.0);
  }
  vWorld = p;
  vNormal = aNormal;
  vColour = aColour;
  vUv = aUv;
  vMat = int(aMat.x + 0.5);
  gl_Position = uProj * uView * vec4(p, 1.0);
}`;

const SHAPE_VS = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec4 iM0;
layout(location = 3) in vec4 iM1;
layout(location = 4) in vec4 iM2;
layout(location = 5) in vec4 iM3;
layout(location = 6) in vec4 iColour;
layout(location = 7) in vec4 iExtra; // taper (cylinders), glyph, unused, unused
uniform mat4 uView;
uniform mat4 uProj;
uniform float uOutline; // pixels, in the outline pass
uniform float uPxScale; // pixels a foot is at a depth of 1 foot (or anywhere, when flat)
out vec3 vWorld;
out vec3 vNormal;
out vec4 vColour;
out vec2 vUv;
flat out int vMat;
void main() {
  mat4 m = mat4(iM0, iM1, iM2, iM3);
  vec3 lp = aPos;
  vec3 ln = aNormal;
  if (iExtra.x > 0.0) {
    lp.xy *= mix(1.0, iExtra.x, lp.z);
    if (abs(ln.z) < 0.5) ln.z = 1.0 - iExtra.x;
  }
  vec3 world = (m * vec4(lp, 1.0)).xyz;
  vec3 n = normalize(transpose(inverse(mat3(m))) * ln);
  if (uOutline > 0.0) {
    vec4 clip = uProj * uView * vec4(world, 1.0);
    // At least a few inches thick, close up, so a near player looks as bold as a far one.
    world += n * max(0.07, uOutline * max(clip.w, 0.01) / uPxScale);
  }
  vWorld = world;
  vNormal = n;
  vColour = iColour;
  vUv = aPos.xy * 0.5 + 0.5;
  vMat = int(iExtra.y + 0.5);
  gl_Position = uProj * uView * vec4(world, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
in vec4 vColour;
in vec2 vUv;
flat in int vMat;
uniform int uPass; // 0 solids (by material), 1 outline, 2 soft shadow, 3 glyph, 4 see-through
uniform vec3 uLight1;
uniform vec3 uLight2;
uniform vec4 uOutlineColour;
uniform sampler2D uTex;
out vec4 outColour;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
// A stripe pattern (1 in the first half of each period, 0 in the second), smoothed where it is too fine to show.
float stripes(float t) {
  float w = fwidth(t);
  float tri = abs(fract(t) - 0.5) * 2.0;
  float s = clamp((tri - 0.5) / max(w * 2.0, 1e-4) + 0.5, 0.0, 1.0);
  return mix(s, 0.5, clamp(w * 2.0 - 0.5, 0.0, 1.0));
}
float tone(vec3 n) {
  float d = max(dot(n, uLight1), dot(n, uLight2) * 0.9);
  return d > 0.12 ? 1.0 : 0.76;
}
vec4 premul(vec3 c, float a) { return vec4(c * a, a); }
void main() {
  if (uPass == 1) { outColour = uOutlineColour; return; }
  if (uPass == 2) {
    float r = length(vUv * 2.0 - 1.0);
    outColour = premul(vColour.rgb, vColour.a * (1.0 - smoothstep(0.35, 1.0, r)));
    return;
  }
  if (uPass == 3) {
    int g = vMat;
    vec2 cell = vec2(float(g % 4), float(g / 4));
    vec4 t = texture(uTex, (cell + vec2(vUv.x, 1.0 - vUv.y)) / 4.0);
    float a = max(t.r, t.g);
    if (a < 0.05) discard;
    vec3 c = mix(uOutlineColour.rgb, vColour.rgb, t.r / max(t.r + t.g, 1e-3));
    outColour = premul(c, a);
    return;
  }
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 c = vColour.rgb;
  if (uPass == 4) { outColour = premul(c, vColour.a); return; }
  int m = vMat;
  vec2 w = vWorld.xy;
  if (m == ${MATERIAL.lit}) c *= tone(n);
  else if (m == ${MATERIAL.grass}) {
    // Mown in stripes out to centre field, and fainter ones across them.
    c = mix(c, c * 1.17, stripes((w.x + 330.0) / 60.0));
    c *= mix(1.0, 0.93, stripes((w.y + 60.0) / 50.0));
  } else if (m == ${MATERIAL.infieldGrass}) {
    c = mix(c, c * 1.17, stripes(dot(w, vec2(-0.7071, 0.7071)) / 18.0));
  } else if (m == ${MATERIAL.dirt}) {
    float fine = noise(w * 1.7);
    float fade = clamp(fwidth(w.x * 1.7) - 0.3, 0.0, 1.0);
    c *= 0.93 + 0.14 * mix(fine, 0.5, fade) + 0.07 * (noise(w * 0.12) - 0.5);
    if (vNormal.z < 0.999) c *= tone(n) * 0.25 + 0.75;
  } else if (m == ${MATERIAL.sign}) {
    vec4 t = texture(uTex, vUv);
    if (t.a < 0.5) discard;
    c = t.rgb * 0.95;
  }
  outColour = vec4(c, 1.0);
}`;

// Puts a picture back as it was drawn, colour and depth (the ballpark, kept from before).
const COPY_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID & 1) << 2) - 1.0, float((gl_VertexID & 2) << 1) - 1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const COPY_FS = `#version 300 es
precision highp float;
uniform sampler2D uColour;
uniform highp sampler2D uDepth;
out vec4 outColour;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  outColour = texelFetch(uColour, p, 0);
  gl_FragDepth = texelFetch(uDepth, p, 0).r;
}`;

const LIGHT1 = norm([0.2, -0.5, 0.85]);
const LIGHT2 = norm([-0.3, 0.6, 0.75]);
const OUTLINE = [0x15 / 255, 0x15 / 255, 0x1c / 255, 1];

function norm(v) {
  const d = Math.hypot(...v);
  return v.map((x) => x / d);
}

const shared = {};

/**
 * A renderer (made when first needed): 'scene' for the full-screen pictures,
 * 'sprite' for the runner's small one, so copying it off is quick.
 */
export function renderer(name = 'scene') {
  shared[name] ??= new Renderer();
  return shared[name];
}

export class Renderer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 16;
    this.canvas.height = 16;
    // Drawn smooth-edged off screen (see begin), then copied onto this canvas.
    const gl = this.canvas.getContext('webgl2', { antialias: false, depth: false, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error('Fielder’s Choice needs WebGL 2');
    this.gl = gl;
    this.samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES));
    this.staticProgram = program(gl, STATIC_VS, FS);
    this.shapeProgram = program(gl, SHAPE_VS, FS);
    this.copyProgram = program(gl, COPY_VS, COPY_FS);
    this.units = {
      sphere: this.unitMesh(unitSphere(18, 12)),
      dome: this.unitMesh(unitDome(18, 7)),
      cyl: this.unitMesh(unitCylinder(18)),
      box: this.unitMesh(unitBox()),
      quad: this.unitMesh(unitQuad()),
    };
    this.instances = gl.createBuffer();
    this.park = null;
    this.glyphTex = null;
    this.boardKey = null;
    this.frame = null; // the picture being drawn
    this.cache = null; // the ballpark on its own, kept while the view stays put: drawn here…
    this.kept = null; // …and kept here, as textures
    this.cacheKey = null;
  }

  /** The ballpark's meshes and pictures, built the first time they're drawn. */
  buildPark(art) {
    const gl = this.gl;
    const signs = signPanels();
    const sheet = art.signSheet(signs);
    const signMesh = new Mesh();
    signs.forEach((panel, i) => {
      const [tl, tr, bl] = panel.corners;
      const br = { x: tr.x + bl.x - tl.x, y: tr.y + bl.y - tl.y, z: tr.z + bl.z - tl.z };
      const { u0, v0, u1, v1 } = sheet.slots[i];
      signMesh.quad(bl, br, tr, tl, [1, 1, 1, 1], MATERIAL.sign, [[u0, v1], [u1, v1], [u1, v0], [u0, v0]]);
    });
    const boardMesh = new Mesh();
    for (const board of art.boards) {
      const [tl, tr, bl] = boardFace(board);
      const br = { x: tr.x + bl.x - tl.x, y: tr.y + bl.y - tl.y, z: tr.z + bl.z - tl.z };
      boardMesh.quad(bl, br, tr, tl, [1, 1, 1, 1], MATERIAL.sign, [[0, 1], [1, 1], [1, 0], [0, 0]]);
    }
    this.park = {
      ground: this.staticMesh(buildGround()),
      solids: this.staticMesh(buildSolids()),
      crowd: this.staticMesh(buildCrowd()),
      signs: this.staticMesh(signMesh),
      boards: this.staticMesh(boardMesh),
      signTex: texture(gl, sheet.canvas),
      boardTex: texture(gl, art.boardCanvas()),
    };
  }

  /**
   * Starts a picture w × h, clear, in the top left corner of the drawing
   * canvas (made at least that big). It is drawn off screen, with smooth
   * edges, until copyTo.
   */
  begin(w, h) {
    const gl = this.gl;
    if (this.canvas.width < w || this.canvas.height < h || !this.frame) {
      this.canvas.width = Math.max(this.canvas.width, w);
      this.canvas.height = Math.max(this.canvas.height, h);
      for (const t of [this.frame, this.cache, this.kept]) if (t) deleteTarget(gl, t);
      this.frame = target(gl, this.canvas.width, this.canvas.height, this.samples);
      this.cache = null;
      this.kept = null;
      this.cacheKey = null;
    }
    this.size = { w, h };
    this.region = [0, this.canvas.height - h, w, this.canvas.height];
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.frame.fbo);
    this.clearRegion();
  }

  clearRegion() {
    const gl = this.gl;
    const [x0, y0, x1, y1] = this.region;
    gl.viewport(x0, y0, x1 - x0, y1 - y0);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x0, y0, x1 - x0, y1 - y0);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  /** Copies the picture onto a 2D canvas, at (x, y). */
  copyTo(ctx, x = 0, y = 0) {
    const gl = this.gl;
    const [x0, y0, x1, y1] = this.region;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.frame.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(x0, y0, x1, y1, x0, y0, x1, y1, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const { w, h } = this.size;
    ctx.drawImage(this.canvas, 0, 0, w, h, x, y, w, h);
  }

  /**
   * Sets the camera: a view's perspective (as makeCamera has it), or, with
   * `sprite`, a flat picture of one player looking the way the view does.
   * With `crop` (a part of the screen, 0–1), the picture is only that part
   * of the view.
   */
  setCamera(view, aspect, { sprite = null, crop = null } = {}) {
    if (sprite) {
      this.view = viewMatrix(view, sprite.origin);
      this.proj = spriteMatrix(sprite.px, this.size.w, this.size.h, sprite.ax, sprite.ay);
      this.pxScale = sprite.px;
      return;
    }
    this.view = viewMatrix(view);
    this.proj = projectionMatrix(view, aspect);
    this.pxScale = view.f * this.size.h;
    if (crop) {
      // Stretch the cropped part over the whole picture.
      const sx = crop.x1 - crop.x0;
      const sy = crop.y1 - crop.y0;
      const cx = crop.x0 + crop.x1 - 1;
      const cy = 1 - (crop.y0 + crop.y1);
      const m = this.proj;
      for (let j = 0; j < 4; j++) {
        m[4 * j] = (m[4 * j] - cx * m[4 * j + 3]) / sx;
        m[4 * j + 1] = (m[4 * j + 1] - cy * m[4 * j + 3]) / sy;
      }
      this.pxScale = (view.f * this.size.h) / sy;
    }
  }

  /**
   * The ballpark: the ground, then everything standing on it, the crowd
   * (reacting as `crowd` says) and the signs. While nothing in it changes,
   * it is drawn once and copied after that.
   */
  drawPark(art, { crowd = null, now = 0, board = null } = {}) {
    const gl = this.gl;
    if (!this.park) this.buildPark(art);
    const boardKey = JSON.stringify(board);
    if (boardKey !== this.boardKey) {
      this.boardKey = boardKey;
      art.paintBoard(board);
      updateTexture(gl, this.park.boardTex, art.boardCanvas());
    }
    let cheer = 0;
    let groan = 0;
    let t = 0;
    if (crowd && crowd.mood !== 'still') {
      t = (now - crowd.since) / 1000;
      const fade = Math.max(0, 1 - t / 2.2);
      if (crowd.mood === 'cheer') cheer = fade;
      else groan = fade;
    }
    const still = cheer === 0 && groan === 0;
    const key = [...this.view, ...this.proj, ...this.region, still].join();
    const [x0, y0, x1, y1] = this.region;
    if (key !== this.cacheKey) {
      this.cache ??= target(gl, this.canvas.width, this.canvas.height, this.samples);
      this.kept ??= textureTarget(gl, this.canvas.width, this.canvas.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.cache.fbo);
      this.clearRegion();
      this.drawParkParts(still, 0, 0, 0);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.cache.fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.kept.fbo);
      gl.blitFramebuffer(x0, y0, x1, y1, x0, y0, x1, y1, gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT, gl.NEAREST);
      this.cacheKey = key;
    }
    // Put the kept ballpark into the picture, depth and all.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.frame.fbo);
    const c = this.copyProgram;
    gl.useProgram(c.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.kept.colour);
    gl.uniform1i(c.u.uColour, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.kept.depth);
    gl.uniform1i(c.u.uDepth, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.ALWAYS);
    gl.depthMask(true);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.depthFunc(gl.LEQUAL);
    // A crowd on its feet moves, so it is drawn afresh each time, and so are the scoreboards.
    this.drawParkParts(false, cheer, groan, t, still ? 'boards' : 'crowd');
  }

  /**
   * Draws the ballpark but for the scoreboards (with the crowd if
   * `withCrowd`), or only the scoreboards, or the crowd and the scoreboards.
   * @param {false|'boards'|'crowd'} only
   */
  drawParkParts(withCrowd, cheer, groan, t, only = false) {
    const gl = this.gl;
    const p = this.staticProgram;
    gl.useProgram(p.program);
    this.common(p);
    gl.uniform4f(p.u.uCrowd, cheer, groan, t, 0);
    gl.uniform1i(p.u.uPass, 0);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    if (only) {
      if (only === 'crowd') this.drawStatic(this.park.crowd);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(-1, -2);
      this.bindTexture(p, this.park.boardTex);
      this.drawStatic(this.park.boards);
      gl.disable(gl.POLYGON_OFFSET_FILL);
      return;
    }
    // The ground is painted layer over layer, all at the same height.
    gl.depthFunc(gl.ALWAYS);
    this.drawStatic(this.park.ground);
    gl.depthFunc(gl.LEQUAL);
    this.drawStatic(this.park.solids);
    if (withCrowd) this.drawStatic(this.park.crowd);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1, -2);
    this.bindTexture(p, this.park.signTex);
    this.drawStatic(this.park.signs);
    gl.disable(gl.POLYGON_OFFSET_FILL);
  }

  /**
   * Shapes (players, the ball, a dropped bat): their shadows, then the
   * solids, their outlines `outline` pixels wide, see-through ones (the
   * ball's trail), and the numbers and letters painted on them.
   * @param {import('./fielders-choice-models.js').Shape[]} shapes
   */
  drawShapes(art, shapes, outline = 1.4) {
    const gl = this.gl;
    this.glyphTex ??= texture(gl, art.glyphSheet());
    const p = this.shapeProgram;
    gl.useProgram(p.program);
    this.common(p);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    const groups = { shadow: [], solid: {}, ghost: [], glyph: [] };
    for (const s of shapes) {
      if (s.shadow) groups.shadow.push(s);
      else if (s.glyph !== undefined) groups.glyph.push(s);
      else if (s.colour[3] < 1) groups.ghost.push(s);
      else (groups.solid[s.mesh] ??= []).push(s);
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1, -4);
    gl.uniform1i(p.u.uPass, 2);
    this.drawInstances('quad', groups.shadow);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.disable(gl.BLEND);
    gl.depthMask(true);

    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.uniform1i(p.u.uPass, 0);
    gl.uniform1f(p.u.uOutline, 0);
    for (const [mesh, list] of Object.entries(groups.solid)) this.drawInstances(mesh, list);
    if (outline > 0) {
      gl.cullFace(gl.FRONT);
      gl.uniform1i(p.u.uPass, 1);
      gl.uniform1f(p.u.uOutline, outline);
      for (const [mesh, list] of Object.entries(groups.solid)) this.drawInstances(mesh, list.filter((s) => s.outline !== false));
      gl.uniform1f(p.u.uOutline, 0);
    }
    gl.disable(gl.CULL_FACE);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.uniform1i(p.u.uPass, 4);
    this.drawInstances('sphere', groups.ghost);
    gl.depthMask(true);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1, -6);
    gl.uniform1i(p.u.uPass, 3);
    this.bindTexture(p, this.glyphTex);
    this.drawInstances('quad', groups.glyph);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.disable(gl.BLEND);
  }

  common(p) {
    const gl = this.gl;
    gl.uniformMatrix4fv(p.u.uView, false, this.view);
    gl.uniformMatrix4fv(p.u.uProj, false, this.proj);
    gl.uniform3fv(p.u.uLight1, LIGHT1);
    gl.uniform3fv(p.u.uLight2, LIGHT2);
    gl.uniform4fv(p.u.uOutlineColour, OUTLINE);
    if (p.u.uPxScale) gl.uniform1f(p.u.uPxScale, this.pxScale);
  }

  bindTexture(p, tex) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(p.u.uTex, 0);
  }

  staticMesh(mesh) {
    const parts = mesh.parts;
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.toArray(), gl.STATIC_DRAW);
    const bytes = STRIDE * 4;
    for (const [loc, size, offset] of [[0, 3, 0], [1, 3, 3], [2, 4, 6], [3, 2, 10], [4, 2, 12]]) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, bytes, offset * 4);
    }
    gl.bindVertexArray(null);
    return { vao, count: mesh.count, parts };
  }

  /** Draws a mesh: of one made in parts, only the parts that can be in the picture. */
  drawStatic(mesh) {
    const gl = this.gl;
    gl.bindVertexArray(mesh.vao);
    if (mesh.parts) {
      for (const part of mesh.parts) {
        if (boxInView(this.view, this.proj, part.min, part.max)) gl.drawArrays(gl.TRIANGLES, part.first, part.count);
      }
    } else {
      gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
    }
    gl.bindVertexArray(null);
  }

  /** A unit shape's vertices (position and normal), with room for each shape drawn from it. */
  unitMesh(data) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);
    return { vao, count: data.length / 6 };
  }

  drawInstances(meshName, list) {
    if (!list.length) return;
    const gl = this.gl;
    const unit = this.units[meshName];
    const data = new Float32Array(list.length * 24);
    list.forEach((s, i) => {
      const o = i * 24;
      const m = s.m;
      for (let k = 0; k < 16; k++) data[o + k] = m[k];
      // A shape turned inside out (its axes left-handed) is flipped back across its x axis, which every unit shape is the same across.
      const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
      if (det < 0) for (let k = 0; k < 3; k++) data[o + k] = -m[k];
      data.set(s.colour, o + 16);
      data[o + 20] = meshName === 'cyl' ? (s.taper ?? 1) : 0;
      data[o + 21] = s.glyph ?? 0;
    });
    gl.bindVertexArray(unit.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
    for (let k = 0; k < 6; k++) {
      const loc = 2 + k;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 96, k * 16);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.drawArraysInstanced(gl.TRIANGLES, 0, unit.count, list.length);
    for (let k = 0; k < 6; k++) {
      gl.vertexAttribDivisor(2 + k, 0);
      gl.disableVertexAttribArray(2 + k);
    }
    gl.bindVertexArray(null);
  }
}

function program(gl, vs, fs) {
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  for (const name of ['uView', 'uProj', 'uCrowd', 'uPass', 'uLight1', 'uLight2', 'uOutlineColour', 'uTex', 'uOutline', 'uPxScale', 'uColour', 'uDepth']) {
    u[name] = gl.getUniformLocation(p, name);
  }
  return { program: p, u };
}

/** An off-screen picture with smooth edges: colour and depth, `samples` to a pixel. */
function target(gl, w, h, samples) {
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  const colour = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, colour);
  gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, w, h);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, colour);
  const depth = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
  gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, w, h);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, colour, depth };
}

/** An off-screen picture kept as textures, colour and depth, one sample to a pixel. */
function textureTarget(gl, w, h) {
  const make = (internal) => {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return tex;
  };
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  const colour = make(gl.RGBA8);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colour, 0);
  const depth = make(gl.DEPTH_COMPONENT24);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, colour, depth, textures: true };
}

function deleteTarget(gl, t) {
  gl.deleteFramebuffer(t.fbo);
  if (t.textures) {
    gl.deleteTexture(t.colour);
    gl.deleteTexture(t.depth);
  } else {
    gl.deleteRenderbuffer(t.colour);
    gl.deleteRenderbuffer(t.depth);
  }
}

function texture(gl, canvas) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

function updateTexture(gl, tex, canvas) {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.generateMipmap(gl.TEXTURE_2D);
}

// ---- Unit shapes: [x, y, z, nx, ny, nz] for each vertex, outward faces anticlockwise ----

/** Puts a triangle's corners in the order that faces the way their normals point. */
function tri(out, a, b, c) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
  const avg = [a[3] + b[3] + c[3], a[4] + b[4] + c[4], a[5] + b[5] + c[5]];
  const order = n[0] * avg[0] + n[1] * avg[1] + n[2] * avg[2] >= 0 ? [a, b, c] : [a, c, b];
  for (const v of order) out.push(...v);
}

function unitSphere(seg, rings, from = 0) {
  const out = [];
  const v = (i, j) => {
    const theta = (j / rings) * Math.PI;
    const phi = (i / seg) * 2 * Math.PI;
    const p = [Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi), Math.cos(theta)];
    return [...p, ...p];
  };
  for (let j = from; j < rings; j++) {
    for (let i = 0; i < seg; i++) {
      tri(out, v(i, j), v(i + 1, j), v(i + 1, j + 1));
      tri(out, v(i, j), v(i + 1, j + 1), v(i, j + 1));
    }
  }
  return out;
}

/** The top half of a sphere (z ≥ 0), closed underneath. */
function unitDome(seg, rings) {
  const out = [];
  const v = (i, j) => {
    const theta = (j / rings) * (Math.PI / 2);
    const phi = (i / seg) * 2 * Math.PI;
    const p = [Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi), Math.cos(theta)];
    return [...p, ...p];
  };
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < seg; i++) {
      tri(out, v(i, j), v(i + 1, j), v(i + 1, j + 1));
      tri(out, v(i, j), v(i + 1, j + 1), v(i, j + 1));
    }
  }
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * 2 * Math.PI;
    const b = ((i + 1) / seg) * 2 * Math.PI;
    tri(out, [0, 0, 0, 0, 0, -1], [Math.cos(a), Math.sin(a), 0, 0, 0, -1], [Math.cos(b), Math.sin(b), 0, 0, 0, -1]);
  }
  return out;
}

/** A cylinder of radius 1 from z = 0 to z = 1, with ends. */
function unitCylinder(seg) {
  const out = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * 2 * Math.PI;
    const b = ((i + 1) / seg) * 2 * Math.PI;
    const [ca, sa, cb, sb] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b)];
    tri(out, [ca, sa, 0, ca, sa, 0], [cb, sb, 0, cb, sb, 0], [cb, sb, 1, cb, sb, 0]);
    tri(out, [ca, sa, 0, ca, sa, 0], [cb, sb, 1, cb, sb, 0], [ca, sa, 1, ca, sa, 0]);
    tri(out, [0, 0, 0, 0, 0, -1], [ca, sa, 0, 0, 0, -1], [cb, sb, 0, 0, 0, -1]);
    tri(out, [0, 0, 1, 0, 0, 1], [ca, sa, 1, 0, 0, 1], [cb, sb, 1, 0, 0, 1]);
  }
  return out;
}

function unitBox() {
  const out = [];
  for (let axis = 0; axis < 3; axis++) {
    for (const s of [-1, 1]) {
      const n = [0, 0, 0];
      n[axis] = s;
      const u = (axis + 1) % 3;
      const w = (axis + 2) % 3;
      const corner = (a, b) => {
        const p = [0, 0, 0];
        p[axis] = s;
        p[u] = a;
        p[w] = b;
        return [...p, ...n];
      };
      tri(out, corner(-1, -1), corner(1, -1), corner(1, 1));
      tri(out, corner(-1, -1), corner(1, 1), corner(-1, 1));
    }
  }
  return out;
}

/** A square from -1 to 1 across x and y, facing +z. */
function unitQuad() {
  const out = [];
  const v = (x, y) => [x, y, 0, 0, 0, 1];
  tri(out, v(-1, -1), v(1, -1), v(1, 1));
  tri(out, v(-1, -1), v(1, 1), v(-1, 1));
  return out;
}

/** The order the glyph sheet's letters and digits are in. */
export { GLYPHS };
