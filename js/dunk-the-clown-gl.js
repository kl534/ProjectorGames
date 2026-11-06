// Dunk the Clown's WebGL renderer: draws what the scene (dunk-the-clown-scene.js)
// says, with a depth buffer so solids hide what is behind them, smooth lighting
// from two lights, and see-through water and glass blended over them. Golden Boot
// draws with it too: a scene may also hand it one big baked mesh with a colour at each
// corner (a stadium full of people, drawn in one go; see `bakeParts` in
// golden-boot-models.js) and a clear colour.
//
// It draws on a canvas that fills the game's screen. The picture is only drawn
// when the game says it has changed, so it stays still the rest of the time. The
// canvas keeps its picture (preserveDrawingBuffer), and numbers each drawing in
// data-rev, so the end-to-end test's simulated camera can film it.

import { MESHES } from './dunk-the-clown-models.js';

const VERTEX = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUv;
layout(location = 3) in vec3 aTint;
uniform mat4 uModel;
uniform mat4 uViewProj;
out vec3 vWorld;
out vec3 vNormal;
out vec2 vUv;
out vec3 vTint;
void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  vWorld = world.xyz;
  vNormal = mat3(transpose(inverse(uModel))) * aNormal;
  vUv = aUv;
  vTint = aTint;
  gl_Position = uViewProj * world;
}`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
in vec2 vUv;
in vec3 vTint;
uniform vec3 uColour;
uniform float uAlpha;
uniform float uShine;
uniform float uGlow;
uniform vec3 uEye;
uniform sampler2D uTex;
uniform int uUseTex;
out vec4 outColour;
void main() {
  if (uUseTex == 1) {
    vec4 t = texture(uTex, vUv);
    if (t.a < 0.02) discard;
    outColour = vec4(t.rgb, t.a * uAlpha);
    return;
  }
  vec3 n = normalize(vNormal);
  vec3 toEye = normalize(uEye - vWorld);
  if (dot(n, toEye) < 0.0 && uAlpha >= 1.0) n = -n;
  vec3 key = normalize(vec3(-0.45, 0.8, 0.75));
  vec3 fill = normalize(vec3(0.7, 0.15, 0.7));
  float diffuse = max(dot(n, key), 0.0);
  float fillLight = max(dot(n, fill), 0.0);
  vec3 ambient = mix(vec3(0.2, 0.19, 0.27), vec3(0.42, 0.43, 0.52), 0.5 + 0.5 * n.y);
  vec3 base = uColour * vTint;
  vec3 lit = base * (ambient + vec3(1.0, 0.95, 0.86) * diffuse * 0.85 + vec3(0.55, 0.65, 1.0) * fillLight * 0.3);
  float spec = pow(max(dot(n, normalize(key + toEye)), 0.0), 36.0) * uShine;
  vec3 colour = mix(lit, base, uGlow) + vec3(1.0, 0.97, 0.9) * spec * 0.6;
  outColour = vec4(colour, uAlpha);
}`;

const LABEL_SIZE = [512, 256];
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export class ClownRenderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL 2 is not available');
    this.gl = gl;
    this.program = this.link(VERTEX, FRAGMENT);
    this.uniforms = Object.fromEntries(
      ['uModel', 'uViewProj', 'uColour', 'uAlpha', 'uShine', 'uGlow', 'uEye', 'uTex', 'uUseTex']
        .map((name) => [name, gl.getUniformLocation(this.program, name)]),
    );
    // Meshes without a colour at each corner are tinted white (the colour of the drawing is all there is).
    gl.vertexAttrib3f(3, 1, 1, 1);
    this.meshes = Object.fromEntries(Object.entries(MESHES).map(([name, build]) => [name, this.upload(build())]));
    this.baked = null; // {key, mesh}: a scene's one big mesh, uploaded when its key changes
    this.labelCanvas = document.createElement('canvas');
    [this.labelCanvas.width, this.labelCanvas.height] = LABEL_SIZE;
    this.labelTexture = gl.createTexture();
    this.label = null;
    this.resize();
  }

  link(vertexSource, fragmentSource) {
    const { gl } = this;
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`Shader: ${gl.getShaderInfoLog(shader)}`);
      return shader;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Shader: ${gl.getProgramInfoLog(program)}`);
    return program;
  }

  /** Puts a mesh on the graphics card. With `colours` (three for each corner), the mesh is tinted by them. */
  upload(data) {
    const { gl } = this;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buffers = [[data.positions, 3], [data.normals, 3], [data.uvs ?? new Float32Array((data.positions.length / 3) * 2), 2]];
    if (data.colours) buffers.push([data.colours, 3]);
    const created = [];
    buffers.forEach(([array, size], location) => {
      const buffer = gl.createBuffer();
      created.push(buffer);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, array, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    });
    const index = gl.createBuffer();
    created.push(index);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return {
      vao, count: data.indices.length, buffers: created,
      type: data.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
    };
  }

  /** Swaps in a scene's baked mesh when it has a new key (a new screen size, say). */
  setBaked(baked) {
    const { gl } = this;
    if (!baked) {
      this.baked = null;
      return;
    }
    if (this.baked?.key === baked.key) return;
    if (this.baked) {
      gl.deleteVertexArray(this.baked.mesh.vao);
      for (const buffer of this.baked.mesh.buffers) gl.deleteBuffer(buffer);
    }
    this.baked = { key: baked.key, mesh: this.upload(baked.build()) };
  }

  /** Match the canvas to the window's size (in device pixels, up to twice the window's). */
  resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(window.innerWidth * ratio));
    this.canvas.height = Math.max(1, Math.round(window.innerHeight * ratio));
  }

  /** Writes the Start target's label (a word, big, with a dark edge) into its texture. */
  setLabel(text) {
    if (text === this.label) return;
    this.label = text;
    const { gl } = this;
    const c = this.labelCanvas.getContext('2d');
    const [w, h] = LABEL_SIZE;
    c.clearRect(0, 0, w, h);
    if (text) {
      let size = 150;
      c.font = `900 ${size}px system-ui, sans-serif`;
      while (c.measureText(text).width > w * 0.92 && size > 20) {
        size -= 6;
        c.font = `900 ${size}px system-ui, sans-serif`;
      }
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.lineJoin = 'round';
      c.lineWidth = size * 0.16;
      c.strokeStyle = '#1a1a1a';
      c.fillStyle = '#ffffff';
      c.strokeText(text, w / 2, h / 2);
      c.fillText(text, w / 2, h / 2);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.labelTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.labelCanvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /**
   * Draws a picture.
   * @param {ReturnType<import('./dunk-the-clown-scene.js').ClownScene['frame']> & {baked?: {key: string, build: () => import('./golden-boot-models.js').BakedMesh}, clear?: number[]}} frame
   */
  draw(frame) {
    const { gl, uniforms } = this;
    this.setLabel(frame.label);
    this.setBaked(frame.baked);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(...(frame.clear ?? [0.08, 0.12, 0.18]), 1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(uniforms.uViewProj, false, frame.camera.viewProj);
    gl.uniform3fv(uniforms.uEye, frame.camera.eye);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.labelTexture);
    gl.uniform1i(uniforms.uTex, 0);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    // Solids first, with the depth buffer on.
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    if (this.baked) this.drawOne({ mesh: this.baked.mesh, m: IDENTITY, colour: [1, 1, 1] });
    for (const d of frame.opaque) this.drawOne(d);

    // Then see-through things, far ones first, which hide nothing behind them.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    const sorted = [...frame.translucent].sort((a, b) => (a.layer ?? 0) - (b.layer ?? 0) || a.m[14] - b.m[14]);
    for (const d of sorted) this.drawOne(d);

    // Last, marks that go on top of everything.
    gl.disable(gl.DEPTH_TEST);
    for (const d of frame.overlay) this.drawOne(d);
    gl.depthMask(true);
    gl.bindVertexArray(null);
    this.canvas.dataset.rev = String((Number(this.canvas.dataset.rev) || 0) + 1);
  }

  drawOne(d) {
    const { gl, uniforms } = this;
    const mesh = typeof d.mesh === 'string' ? this.meshes[d.mesh] : d.mesh;
    gl.bindVertexArray(mesh.vao);
    gl.uniformMatrix4fv(uniforms.uModel, false, d.m);
    gl.uniform3fv(uniforms.uColour, d.colour);
    gl.uniform1f(uniforms.uAlpha, d.alpha ?? 1);
    gl.uniform1f(uniforms.uShine, d.shine ?? 0);
    gl.uniform1f(uniforms.uGlow, d.glow ?? 0);
    gl.uniform1i(uniforms.uUseTex, d.tex ? 1 : 0);
    gl.drawElements(gl.TRIANGLES, mesh.count, mesh.type, 0);
  }
}
