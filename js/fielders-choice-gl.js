// Fielder's Choice's WebGL renderer: draws the ballpark and the players built
// in fielders-choice-models.js, through a view from fielders-choice-logic.js,
// with a depth buffer so everything hides what is behind it. It draws on a
// canvas of its own, off the page; the art copies each picture onto the
// game's canvases (the scene, the covering fielder, the runner), so the rest
// of the game (and the camera watching for throws) sees ordinary canvases.
//
// The look is a night game's: everything is lit (in linear light) by the
// lamps on the four light towers, each brightest in the pool of light it is
// aimed at, and by the night sky and the light bounced off the field. Each
// player's piece has a finish (cloth, skin, leather, a shiny helmet…) that
// says how soft it is and how it catches the lamps' highlights, and every
// player and the ball casts a faint shadow away from each tower. The grass is
// mown in stripes that shift with where you look from, with blades, patches
// and worn spots; the dirt has grain, drag marks and scuffs. Far things fade
// into the night air. (An outline pass, each shape drawn again a little
// bigger and inside out, is still there for anything that asks for one.)

import {
  COLOURS, CROWD_PART, CROWD_STRIDE, FIELD, LAMPS, MATERIAL, STRIDE, TOWER_AIMS, boardFace, boxInView, buildCrowd, buildGround, buildNet, buildSolids,
  crowdTemplate, projectionMatrix, rgb, signPanels, spriteMatrix, viewMatrix, Mesh, GLYPHS,
} from './fielders-choice-models.js';
import { BASES, FIELDERS } from './fielders-choice-logic.js';

const MOUND = { centre: { x: 0, y: FIELD.mound.centre }, ...FIELD.mound };
// Where the grass is worn by the fielders standing on it, and the dirt scuffed by feet.
const WORN = ['1B', '2B', 'SS', '3B', 'LF', 'CF', 'RF'].map((id) => FIELDERS[id].spot);
const SCUFFED = [BASES.first, BASES.second, BASES.third, { x: 0, y: 0.8 }, { x: -2.6, y: 0.8 }, { x: 2.6, y: 0.8 }, { x: 0, y: 61 }, { x: 0, y: 57 }];
const SCUFF_RADIUS = 3.2;

const STATIC_VS = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec4 aColour;
layout(location = 3) in vec2 aUv;
layout(location = 4) in vec2 aMat;
uniform mat4 uView;
uniform mat4 uProj;
out vec3 vWorld;
out vec3 vNormal;
out vec4 vColour;
out vec2 vUv;
flat out int vMat;
flat out int vFinish;
out float vHeight;
void main() {
  vec3 p = aPos;
  vWorld = p;
  vNormal = aNormal;
  vColour = aColour;
  vUv = aUv;
  vMat = int(aMat.x + 0.5);
  vFinish = 0;
  vHeight = 0.0;
  gl_Position = uProj * uView * vec4(p, 1.0);
}`;

// The crowd, one seat at a time (instanced): the seat and whoever sits in it, turned to face the field, in their
// colours. In a cheer they bob up and down, and some throw their arms up; in a groan they slump.
const CROWD_VS = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in float aPart;
layout(location = 3) in vec4 iAt; // x, y, z, the angle they face
layout(location = 4) in vec4 iShirt; // colour, hash
layout(location = 5) in vec4 iSkin; // colour, who: 0 an empty seat, 1 a fan, 2 a player on the bench
layout(location = 6) in vec4 iHat; // hair or cap colour, 1 for a cap
layout(location = 7) in vec4 iPants; // colour, unused
uniform mat4 uView;
uniform mat4 uProj;
uniform vec4 uCrowd; // cheer (0–1, fading), groan (0–1), seconds since it started, unused
uniform vec3 uChair;
out vec3 vWorld;
out vec3 vNormal;
out vec4 vColour;
out vec2 vUv;
flat out int vMat;
flat out int vFinish;
out float vHeight;
void main() {
  int part = int(aPart + 0.5);
  float hash = iShirt.w;
  float who = iSkin.w;
  bool person = part != ${CROWD_PART.chair};
  bool fan = who > 0.5 && who < 1.5;
  bool hidden = (who < 0.5 && person) || (who > 1.5 && part == ${CROWD_PART.chair}) || (part == ${CROWD_PART.brim} && iHat.w < 0.5);
  bool armsUp = fan && uCrowd.x > 0.15 && mod(hash, 3.0) >= 1.0;
  if (part == ${CROWD_PART.arms} || part == ${CROWD_PART.hands}) hidden = hidden || armsUp;
  if (part == ${CROWD_PART.armsUp} || part == ${CROWD_PART.handsUp}) hidden = hidden || !armsUp;
  if (hidden) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 colour = vec3(0.07, 0.07, 0.08);
  if (part == ${CROWD_PART.shirt} || part == ${CROWD_PART.arms} || part == ${CROWD_PART.armsUp}) colour = iShirt.rgb;
  else if (part == ${CROWD_PART.skin} || part == ${CROWD_PART.hands} || part == ${CROWD_PART.handsUp}) colour = iSkin.rgb;
  else if (part == ${CROWD_PART.hair} || part == ${CROWD_PART.brim}) colour = iHat.rgb;
  else if (part == ${CROWD_PART.pants}) colour = iPants.rgb;
  else if (part == ${CROWD_PART.chair}) colour = uChair;
  vec3 lp = aPos;
  if (person && fan) {
    float jump = max(0.0, sin(uCrowd.z * 11.0 + mod(hash, 13.0))) * 1.1 * uCrowd.x;
    // Up off their seat in a cheer, then back down; slumped (the upper body only) in a groan.
    lp.z += jump * (part == ${CROWD_PART.shoes} ? 0.2 : 1.0) - (lp.z > 2.6 ? 0.35 * uCrowd.y : 0.0);
  }
  float c = cos(iAt.w);
  float s = sin(iAt.w);
  vec3 right = vec3(c, -s, 0.0);
  vec3 ahead = vec3(s, c, 0.0);
  vec3 p = iAt.xyz + right * lp.x + ahead * lp.y + vec3(0.0, 0.0, lp.z);
  vWorld = p;
  vNormal = right * aNormal.x + ahead * aNormal.y + vec3(0.0, 0.0, aNormal.z);
  // Out of the lamps' pools of light, so a little dimmer than the field.
  vColour = vec4(colour * (0.74 + 0.14 * fract(hash * 0.618)), 1.0);
  vUv = vec2(0.0);
  vMat = 0;
  vFinish = 0;
  vHeight = 0.0;
  gl_Position = uProj * uView * vec4(p, 1.0);
}`;

// The ground's height (the mound), as groundHeight in fielders-choice-models.js has it, for shadows cast on it.
const GROUND_GLSL = `
float groundAt(vec2 p) {
  float r = length(p - vec2(0.0, ${MOUND.centre.toFixed(2)}));
  float t = clamp((r - ${MOUND.top.toFixed(2)}) / ${(MOUND.radius - MOUND.top).toFixed(2)}, 0.0, 1.0);
  return r >= ${MOUND.radius.toFixed(2)} ? 0.0 : ${MOUND.height.toFixed(4)} * (1.0 - t * t * (3.0 - 2.0 * t));
}`;

const SHAPE_VS = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec4 iM0;
layout(location = 3) in vec4 iM1;
layout(location = 4) in vec4 iM2;
layout(location = 5) in vec4 iM3;
layout(location = 6) in vec4 iColour;
layout(location = 7) in vec4 iExtra; // taper (cylinders), glyph, finish, unused
layout(location = 8) in vec3 iN0; // the matrix for normals (the inverse transpose of the shape's own), worked out once a shape
layout(location = 9) in vec3 iN1;
layout(location = 10) in vec3 iN2;
uniform mat4 uView;
uniform mat4 uProj;
uniform float uOutline; // pixels, in the outline pass
uniform float uPxScale; // pixels a foot is at a depth of 1 foot (or anywhere, when flat)
uniform vec4 uShadow; // a lamp (xyz) casting shadows on the ground, in the shadow pass (w = 1)
out vec3 vWorld;
out vec3 vNormal;
out vec4 vColour;
out vec2 vUv;
flat out int vMat;
flat out int vFinish;
out float vHeight;
${GROUND_GLSL}
void main() {
  mat4 m = mat4(iM0, iM1, iM2, iM3);
  vec3 lp = aPos;
  vec3 ln = aNormal;
  if (iExtra.x > 0.0) {
    lp.xy *= mix(1.0, iExtra.x, lp.z);
    if (abs(ln.z) < 0.5) ln.z = 1.0 - iExtra.x;
  }
  vec3 world = (m * vec4(lp, 1.0)).xyz;
  vec3 n = normalize(mat3(iN0, iN1, iN2) * ln);
  vHeight = 0.0;
  if (uShadow.w > 0.0) {
    // Cast along the line from the lamp onto the ground (twice, to find the mound's height where it lands).
    vec3 d = world - uShadow.xyz;
    float g = groundAt(world.xy);
    vHeight = max(0.0, world.z - g);
    d.z = min(d.z, -1e-3);
    vec3 q = uShadow.xyz + d * ((g + 0.04 - uShadow.z) / d.z);
    g = groundAt(q.xy);
    world = uShadow.xyz + d * ((g + 0.04 - uShadow.z) / d.z);
  }
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
  vFinish = int(iExtra.z + 0.5);
  gl_Position = uProj * uView * vec4(world, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
in vec4 vColour;
in vec2 vUv;
flat in int vMat;
flat in int vFinish;
in float vHeight;
uniform int uPass; // 0 solids (by material), 1 outline, 2 soft shadow, 3 glyph, 4 see-through, 5 cast shadow
uniform int uShapes; // 1 for the players and the ball (their finish says what they are made of), 0 for the ballpark
uniform vec4 uOutlineColour;
uniform sampler2D uTex;
uniform float uShadowAlpha;
uniform vec3 uEye;
out vec4 outColour;

// The night air, which far things fade into; the light towers' lamps and where each is aimed.
const vec3 HAZE = vec3(0.15, 0.18, 0.29);
const vec3 LAMPS[${LAMPS.length}] = vec3[${LAMPS.length}](${LAMPS.map((p) => `vec3(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`).join(', ')});
const vec2 TOWER_AIMS[${TOWER_AIMS.length}] = vec2[${TOWER_AIMS.length}](${TOWER_AIMS.map((p) => `vec2(${p.x.toFixed(1)}, ${p.y.toFixed(1)})`).join(', ')});
const vec2 SCUFFED_AT[${SCUFFED.length}] = vec2[${SCUFFED.length}](${SCUFFED.map((p) => `vec2(${p.x.toFixed(1)}, ${p.y.toFixed(1)})`).join(', ')});
const vec2 WORN[${WORN.length}] = vec2[${WORN.length}](${WORN.map((p) => `vec2(${p.x.toFixed(1)}, ${p.y.toFixed(1)})`).join(', ')});
const vec3 LAMP_COLOUR = vec3(1.0, 0.94, 0.82);
const vec3 SKY_LIGHT = vec3(0.10, 0.13, 0.24);
const vec3 BOUNCE = vec3(0.12, 0.15, 0.09);

// A hash of a cell's corner, by integer arithmetic (a sine-based one streaks on some GPUs far from the origin).
float hash(vec2 p) {
  uvec2 q = uvec2(ivec2(p) + 32768);
  uint h = q.x * 1597334677u ^ q.y * 3812015801u;
  h = (h ^ (h >> 16)) * 2246822519u;
  h ^= h >> 13;
  return float(h & 0xffffffu) / 16777215.0;
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
// Noise in a few octaves, smoothed away where it is too fine to show (so it doesn't shimmer far off).
float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    float fade = clamp(fwidth(p.x) * 1.5 - 0.5, 0.0, 1.0);
    s += a * mix(noise(p), 0.5, fade);
    p = p * 2.03 + vec2(17.1, 5.3);
    a *= 0.5;
  }
  return s / 0.875;
}
// A stripe pattern (1 in the first half of each period, 0 in the second), smoothed where it is too fine to show.
float stripes(float t) {
  float w = fwidth(t);
  float tri = abs(fract(t) - 0.5) * 2.0;
  float s = clamp((tri - 0.5) / max(w * 2.0, 1e-4) + 0.5, 0.0, 1.0);
  return mix(s, 0.5, clamp(w * 2.0 - 0.5, 0.0, 1.0));
}
vec3 toLinear(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
vec3 toScreen(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }
vec4 premul(vec3 c, float a) { return vec4(c * a, a); }
// How much of the night air is between the eye and here.
float haze() { return 0.24 * (1.0 - exp(-length(vWorld - uEye) / 430.0)); }

// How a surface is lit (linear light, times its colour): the lamps on the four towers, each brightest in the pool
// it is aimed at, plus the night sky above and the light bounced off the field below. \`wrap\` lets light round
// soft things (cloth, skin), and \`gloss\`/\`shine\` give the lamps' highlights on shiny ones (a helmet, leather).
vec3 lighting(vec3 n, float wrap, float gloss, float shine, out vec3 spec) {
  vec3 v = normalize(uEye - vWorld);
  vec3 sum = mix(BOUNCE, SKY_LIGHT, n.z * 0.5 + 0.5) * 1.5;
  spec = vec3(0.0);
  for (int i = 0; i < ${LAMPS.length}; i++) {
    vec3 toLamp = LAMPS[i] - vWorld;
    float d = length(toLamp);
    vec3 l = toLamp / d;
    vec3 aim = normalize(vec3(TOWER_AIMS[i], 0.0) - LAMPS[i]);
    float spot = 0.45 + 0.55 * smoothstep(0.80, 0.97, dot(-l, aim));
    float k = spot * pow(380.0 / d, 1.3) * 0.36;
    float lambert = max(0.0, (dot(n, l) + wrap) / (1.0 + wrap));
    sum += LAMP_COLOUR * lambert * k;
    if (gloss > 0.0) {
      vec3 h = normalize(l + v);
      spec += LAMP_COLOUR * k * gloss * pow(max(dot(n, h), 0.0), shine) * step(0.0, dot(n, l));
    }
  }
  return sum;
}

// The finishes players and the ball are made of: wrap, gloss and shine.
vec3 finishOf(int f) {
  if (f == 1) return vec3(0.45, 0.10, 14.0); // skin
  if (f == 2) return vec3(0.15, 0.22, 22.0); // leather (gloves, belts)
  if (f == 3) return vec3(0.05, 0.85, 70.0); // a batting helmet's shell
  if (f == 4) return vec3(0.10, 0.30, 30.0); // cleats, rubber
  if (f == 5) return vec3(0.10, 0.45, 40.0); // a varnished bat
  if (f == 6) return vec3(0.30, 0.08, 10.0); // the ball's leather
  if (f == 7) return vec3(0.20, 0.0, 1.0); // hair, eyes: matt
  return vec3(0.35, 0.03, 6.0); // cloth
}

void main() {
  if (uPass == 1) { outColour = vec4(mix(uOutlineColour.rgb, HAZE, haze()), 1.0); return; }
  if (uPass == 2) {
    float r = length(vUv * 2.0 - 1.0);
    outColour = premul(vColour.rgb, vColour.a * (1.0 - smoothstep(0.2, 1.0, r)));
    return;
  }
  if (uPass == 5) {
    // A shadow cast by a lamp: softer and fainter for the parts of a player higher off the ground.
    outColour = vec4(0.0, 0.0, 0.0, uShadowAlpha * (1.0 - 0.5 * clamp(vHeight / 8.0, 0.0, 1.0)));
    return;
  }
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 albedo = toLinear(vColour.rgb);
  vec3 spec;
  if (uPass == 3) {
    int g = vMat;
    vec2 cell = vec2(float(g % 4), float(g / 4));
    vec4 t = texture(uTex, (cell + vec2(vUv.x, 1.0 - vUv.y)) / 4.0);
    float a = max(t.r, t.g);
    if (a < 0.05) discard;
    vec3 c = mix(toLinear(uOutlineColour.rgb), albedo, t.r / max(t.r + t.g, 1e-3));
    vec3 lit = lighting(n, 0.35, 0.0, 1.0, spec);
    outColour = premul(mix(toScreen(c * lit), HAZE, haze()), a);
    return;
  }
  if (uPass == 4) { outColour = premul(mix(vColour.rgb, HAZE, haze()), vColour.a); return; }
  if (uShapes == 1) {
    vec3 f = finishOf(vFinish);
    vec3 lit = lighting(n, f.x, f.y, f.z, spec);
    // The edges turned away from the eye catch the lamps behind them, which lifts the players off the field.
    float rim = pow(1.0 - max(dot(n, normalize(uEye - vWorld)), 0.0), 3.0) * clamp(n.z + 0.6, 0.0, 1.0);
    vec3 c = albedo * lit + spec + rim * vec3(0.95, 0.84, 0.6) * 0.05;
    outColour = vec4(mix(toScreen(c), HAZE, haze()), 1.0);
    return;
  }
  int m = vMat;
  vec2 w = vWorld.xy;
  if (m == ${MATERIAL.glow}) { outColour = vec4(vColour.rgb, 1.0); return; }
  bool ground = m == ${MATERIAL.grass} || m == ${MATERIAL.infieldGrass} || m == ${MATERIAL.dirt} || m == ${MATERIAL.flat};
  vec3 c = albedo;
  float gloss = 0.0;
  float shine = 1.0;
  if (m == ${MATERIAL.grass} || m == ${MATERIAL.infieldGrass}) {
    // Mown in stripes: the blades in each stripe lean the way the mower went, so a stripe looks lighter seen
    // along the blades and darker against them, and which is which changes with where you look from.
    vec2 toEye = normalize(uEye.xy - w + vec2(1e-3));
    vec2 mow = m == ${MATERIAL.grass} ? vec2(1.0, 0.0) : vec2(0.7071, 0.7071);
    float t = m == ${MATERIAL.grass} ? (w.x + 330.0) / 60.0 : dot(w, vec2(-0.7071, 0.7071)) / 18.0;
    float s = stripes(t) * 2.0 - 1.0;
    float along = dot(toEye, vec2(mow.y, -mow.x));
    c *= 1.0 + 0.16 * s * (0.35 + 0.65 * abs(along)) * sign(along + 1e-3);
    if (m == ${MATERIAL.grass}) c *= 1.0 - 0.06 * (stripes((w.y + 60.0) / 50.0) * 2.0 - 1.0) * dot(toEye, vec2(0.0, 1.0));
    // Blades and clumps close up, patches and worn spots where the fielders stand further off.
    c *= 0.9 + 0.2 * fbm(w * 2.4) + 0.12 * (fbm(w * 0.03) - 0.5);
    float wear = 0.0;
    for (int i = 0; i < ${WORN.length}; i++) {
      vec2 d = (w - WORN[i]) / 7.0;
      wear += exp(-dot(d, d));
    }
    c = mix(c, c * vec3(1.15, 1.02, 0.7), clamp(wear, 0.0, 1.0) * (0.35 + 0.4 * noise(w * 0.9)));
  } else if (m == ${MATERIAL.dirt}) {
    // Groomed clay: fine grain, darker damp patches, the faint arcs the drag leaves round the mound, and
    // scuffed, darker ground where feet go (round the bags, the mound and the plate).
    c *= 0.86 + 0.2 * fbm(w * 1.9) + 0.1 * (fbm(w * 0.08) - 0.5);
    c *= 1.0 - 0.045 * stripes(length(w - vec2(0.0, 60.5)) / 2.2) * clamp(1.0 - fwidth(length(w)) * 2.0, 0.0, 1.0);
    float scuff = 0.0;
    for (int i = 0; i < ${SCUFFED.length}; i++) {
      vec2 d = (w - SCUFFED_AT[i]) / ${SCUFF_RADIUS.toFixed(1)};
      scuff += exp(-dot(d, d));
    }
    c *= 1.0 - clamp(scuff, 0.0, 1.0) * (0.08 + 0.22 * smoothstep(0.45, 0.8, noise(w * 3.1)));
    gloss = 0.02;
    shine = 4.0;
  } else if (m == ${MATERIAL.flat}) {
    // Chalk and paint: a little patchy.
    c *= 0.9 + 0.14 * fbm(w * 4.0);
  } else if (m == ${MATERIAL.sign}) {
    vec4 t = texture(uTex, vUv);
    if (t.a < 0.5) discard;
    c = toLinear(t.rgb * 0.95);
    gloss = 0.05;
    shine = 12.0;
  } else if (m == ${MATERIAL.metal}) {
    gloss = 0.5;
    shine = 40.0;
  } else if (m == ${MATERIAL.net}) {
    // A mesh of thin cords, two inches apart: how much of each pixel is cord, so far off it is a faint haze.
    vec2 g = vec2(length(w - vec2(0.0, 0.0)), vWorld.z) * 6.0;
    vec2 d = abs(fract(g) - 0.5);
    vec2 fw = max(fwidth(g), vec2(1e-4));
    vec2 cover = clamp((0.06 - (0.5 - d)) / fw + 0.5, 0.0, 1.0);
    float cord = max(max(cover.x, cover.y), 0.12 * clamp(max(fw.x, fw.y) * 4.0, 0.0, 1.0));
    vec3 lit = lighting(n, 0.5, 0.0, 1.0, spec);
    outColour = premul(mix(toScreen(c * lit), HAZE, haze()), min(0.75, cord));
    return;
  }
  vec3 lit = lighting(ground ? vec3(0.0, 0.0, 1.0) : n, ground ? 0.0 : 0.25, gloss, shine, spec);
  vec3 col = c * lit + spec * (ground ? 0.5 : 1.0);
  outColour = vec4(mix(toScreen(col), HAZE, haze()), 1.0);
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

const OUTLINE = [0x15 / 255, 0x15 / 255, 0x1c / 255, 1];
// The finishes a shape can have (its `finish`), as the shader numbers them.
export const FINISH = { cloth: 0, skin: 1, leather: 2, gloss: 3, rubber: 4, wood: 5, ball: 6, matt: 7 };
// How dark each lamp's shadow is (several overlap under a player, as at a real night game).
const SHADOW_ALPHA = 0.15;
// Stands nearer the eye than this (feet) show their crowd in full.
const CROWD_NEAR = 110;
// …and beyond this, only the front of each (a few pixels).
const CROWD_FAR = 200;

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
    this.crowdProgram = program(gl, CROWD_VS, FS);
    this.copyProgram = program(gl, COPY_VS, COPY_FS);
    this.units = {
      sphere: this.unitMesh(unitSphere(14, 9)),
      sphereMid: this.unitMesh(unitSphere(10, 7)),
      sphereLo: this.unitMesh(unitSphere(6, 4)),
      dome: this.unitMesh(unitDome(14, 6)),
      cyl: this.unitMesh(unitCylinder(12)),
      cylLo: this.unitMesh(unitCylinder(6)),
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
      net: this.staticMesh(buildNet()),
      crowd: this.crowdMesh(buildCrowd()),
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
    gl.clearStencil(0);
    gl.depthMask(true);
    gl.stencilMask(0xff);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
  }

  /** Copies the picture onto a 2D canvas, at (x, y), stretched to `w` × `h` if given. */
  copyTo(ctx, x = 0, y = 0, w = this.size.w, h = this.size.h) {
    const gl = this.gl;
    const [x0, y0, x1, y1] = this.region;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.frame.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(x0, y0, x1, y1, x0, y0, x1, y1, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    ctx.drawImage(this.canvas, 0, 0, this.size.w, this.size.h, x, y, w, h);
  }

  /**
   * Sets the camera: a view's perspective (as makeCamera has it), or, with
   * `sprite`, a flat picture of one player looking the way the view does.
   * With `crop` (a part of the screen, 0–1), the picture is only that part
   * of the view.
   */
  setCamera(view, aspect, { sprite = null, crop = null } = {}) {
    this.flat = Boolean(sprite);
    if (sprite) {
      this.view = viewMatrix(view, sprite.origin);
      this.proj = spriteMatrix(sprite.px, this.size.w, this.size.h, sprite.ax, sprite.ay);
      this.pxScale = sprite.px;
      this.eye = view.eye;
      return;
    }
    this.eye = view.eye;
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
    const start = () => {
      gl.useProgram(p.program);
      this.common(p);
      gl.uniform1i(p.u.uShapes, 0);
      gl.uniform1i(p.u.uPass, 0);
    };
    start();
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    if (only) {
      if (only === 'crowd') {
        this.drawCrowd(cheer, groan, t);
        start();
        this.drawNet();
      }
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
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1, -2);
    this.bindTexture(p, this.park.signTex);
    this.drawStatic(this.park.signs);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    if (withCrowd) {
      this.drawCrowd(0, 0, 0);
      start();
      this.drawNet();
    }
  }

  /** The net behind home plate, over whatever is behind it. */
  drawNet() {
    const gl = this.gl;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    this.drawStatic(this.park.net);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  /**
   * The crowd in the stands that can be in the picture: those near the eye
   * in full, the rest as a seat, a body and a head (they are only a few pixels).
   */
  drawCrowd(cheer, groan, t) {
    const gl = this.gl;
    const p = this.crowdProgram;
    const crowd = this.park.crowd;
    gl.useProgram(p.program);
    this.common(p);
    gl.uniform4f(p.u.uCrowd, cheer, groan, t, 0);
    gl.uniform3fv(p.u.uChair, crowd.chair);
    gl.uniform1i(p.u.uShapes, 0);
    gl.uniform1i(p.u.uPass, 0);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    const eye = this.eye ?? { x: 0, y: 0, z: 0 };
    for (const part of crowd.parts) {
      if (!boxInView(this.view, this.proj, part.min, part.max)) continue;
      const far = Math.hypot(part.centre.x - eye.x, part.centre.y - eye.y, part.centre.z - eye.z);
      const template = far < CROWD_NEAR ? crowd.near : far < CROWD_FAR ? crowd.far : crowd.farthest;
      gl.bindVertexArray(template.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, crowd.instances);
      for (let k = 0; k < 5; k++) gl.vertexAttribPointer(3 + k, 4, gl.FLOAT, false, CROWD_STRIDE * 4, (part.first * CROWD_STRIDE + k * 4) * 4);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, template.count, part.count);
    }
    gl.bindVertexArray(null);
    gl.disable(gl.CULL_FACE);
  }

  /** The crowd's instances (one to a seat) and the two pictures of a seat and its person, near and far. */
  crowdMesh(crowd) {
    const gl = this.gl;
    const instances = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, instances);
    gl.bufferData(gl.ARRAY_BUFFER, crowd.data, gl.STATIC_DRAW);
    const template = (data) => {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      for (const [loc, size, offset] of [[0, 3, 0], [1, 3, 3], [2, 1, 6]]) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 28, offset * 4);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, instances);
      for (let k = 0; k < 5; k++) {
        gl.enableVertexAttribArray(3 + k);
        gl.vertexAttribPointer(3 + k, 4, gl.FLOAT, false, CROWD_STRIDE * 4, k * 16);
        gl.vertexAttribDivisor(3 + k, 1);
      }
      gl.bindVertexArray(null);
      return { vao, count: data.length / 7 };
    };
    return {
      instances, parts: crowd.parts, chair: rgb(COLOURS.seats).slice(0, 3),
      near: template(crowdTemplate('near')), far: template(crowdTemplate('far')), farthest: template(crowdTemplate('farthest')),
    };
  }

  /**
   * Shapes (players, the ball, a dropped bat): the soft shadows under them
   * and the shadows they cast from each tower's lamps, then the solids (with
   * outlines `outline` pixels wide, if asked for), see-through ones (the
   * ball's trail), and the numbers and letters painted on them.
   * @param {import('./fielders-choice-models.js').Shape[]} shapes
   */
  drawShapes(art, shapes, outline = 0) {
    const gl = this.gl;
    this.glyphTex ??= texture(gl, art.glyphSheet());
    const p = this.shapeProgram;
    gl.useProgram(p.program);
    this.common(p);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    const groups = { shadow: [], solid: {}, ghost: [], glyph: [] };
    const px = this.pixelsOf();
    for (const s of shapes) {
      if (s.shadow) groups.shadow.push(s);
      else if (s.glyph !== undefined) groups.glyph.push(s);
      else if (s.colour[3] < 1) groups.ghost.push(s);
      else (groups.solid[meshFor(s, px(s))] ??= []).push(s);
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1, -4);
    gl.uniform1i(p.u.uShapes, 1);
    gl.uniform1i(p.u.uPass, 2);
    this.drawInstances('quad', groups.shadow);
    // Each lamp's shadow darkens the ground once however many pieces overlap in it (the stencil marks
    // where this lamp has darkened already), and only the ground: they are drawn before the players.
    // Only the bigger pieces cast shadows (an eye or a button's shadow would be lost under the rest), and from fewer
    // triangles: a shadow is only an outline, and a soft one.
    const casters = { sphereLo: [], cylLo: [], box: [], dome: [] };
    for (const [mesh, list] of Object.entries(groups.solid)) {
      if (mesh === 'quad') continue;
      const lo = mesh.startsWith('sphere') ? 'sphereLo' : mesh === 'cyl' ? 'cylLo' : mesh;
      for (const sh of list) if (sh.cast !== false && sizeOf(sh) >= SHADOW_SIZE && px(sh) * sizeOf(sh) >= SHADOW_PIXELS) casters[lo].push(sh);
    }
    if (Object.values(casters).some((list) => list.length)) {
      gl.uniform1i(p.u.uPass, 5);
      gl.uniform1f(p.u.uShadowAlpha, SHADOW_ALPHA);
      gl.enable(gl.STENCIL_TEST);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
      LAMPS.forEach((lamp, i) => {
        gl.stencilFunc(gl.NOTEQUAL, i + 1, 0xff);
        gl.uniform4f(p.u.uShadow, lamp.x, lamp.y, lamp.z, 1);
        for (const [mesh, list] of Object.entries(casters)) this.drawInstances(mesh, list);
      });
      gl.uniform4f(p.u.uShadow, 0, 0, 0, 0);
      gl.disable(gl.STENCIL_TEST);
    }
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

  /** How many pixels a foot is at a shape (in the picture as the camera is now set): small far things need fewer triangles. */
  pixelsOf() {
    const v = this.view;
    const scale = this.pxScale;
    if (this.flat) return () => scale;
    return (s) => {
      const depth = v[2] * s.m[12] + v[6] * s.m[13] + v[10] * s.m[14] + v[14];
      return scale / Math.max(1, depth);
    };
  }

  common(p) {
    const gl = this.gl;
    gl.uniformMatrix4fv(p.u.uView, false, this.view);
    gl.uniformMatrix4fv(p.u.uProj, false, this.proj);
    gl.uniform4fv(p.u.uOutlineColour, OUTLINE);
    if (p.u.uShadow) gl.uniform4f(p.u.uShadow, 0, 0, 0, 0);
    const eye = this.eye ?? { x: 0, y: 0, z: 0 };
    gl.uniform3f(p.u.uEye, eye.x, eye.y, eye.z);
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
    const data = new Float32Array(list.length * INSTANCE_FLOATS);
    list.forEach((s, i) => {
      const o = i * INSTANCE_FLOATS;
      const m = s.m;
      for (let k = 0; k < 16; k++) data[o + k] = m[k];
      // A shape turned inside out (its axes left-handed) is flipped back across its x axis, which every unit shape is the same across.
      const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
      if (det < 0) for (let k = 0; k < 3; k++) data[o + k] = -m[k];
      data.set(s.colour, o + 16);
      data[o + 20] = meshName.startsWith('cyl') ? (s.taper ?? 1) : 0;
      data[o + 21] = s.glyph ?? 0;
      data[o + 22] = FINISH[s.finish] ?? 0;
      normalMatrix(data, o, o + 24);
    });
    gl.bindVertexArray(unit.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
    for (let k = 0; k < 9; k++) {
      const loc = 2 + k;
      gl.enableVertexAttribArray(loc);
      if (k < 6) gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, INSTANCE_FLOATS * 4, k * 16);
      else gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, INSTANCE_FLOATS * 4, (24 + (k - 6) * 3) * 4);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.drawArraysInstanced(gl.TRIANGLES, 0, unit.count, list.length);
    for (let k = 0; k < 9; k++) {
      gl.vertexAttribDivisor(2 + k, 0);
      gl.disableVertexAttribArray(2 + k);
    }
    gl.bindVertexArray(null);
  }
}

// Floats for each shape drawn: its matrix (16), colour (4), extras (4) and the matrix for its normals (9).
const INSTANCE_FLOATS = 33;
// Pieces smaller than this (feet across their widest) cast no shadow; spheres this small or a little bigger are
// drawn with fewer triangles (they are only a few pixels).
const SHADOW_SIZE = 0.09;
// …nor do pieces smaller than this in the picture (pixels across): their shadow would be a speck.
const SHADOW_PIXELS = 2.5;
const SMALL = { lo: 0.07, mid: 0.2 };

/** How big a shape is: the longest of its first two axes (its width). */
function sizeOf(s) {
  const m = s.m;
  return Math.max(Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]));
}

/**
 * Which unit mesh draws a shape, `px` pixels to a foot where it is: spheres small in the picture with fewer
 * triangles, and a limb far off as a six-sided one.
 */
function meshFor(s, px) {
  const size = Math.max(sizeOf(s), Math.hypot(s.m[8], s.m[9], s.m[10]));
  const pixels = size * px;
  if (s.mesh === 'cyl') return pixels < 8 ? 'cylLo' : 'cyl';
  if (s.mesh !== 'sphere') return s.mesh;
  if (size < SMALL.lo || pixels < 5) return 'sphereLo';
  return size < SMALL.mid || pixels < 16 ? 'sphereMid' : 'sphere';
}

/** Writes the inverse transpose of the 3×3 part of the matrix at `data[from]` (column-major) at `data[to]`, column by column. */
function normalMatrix(data, from, to) {
  const a = data[from]; const b = data[from + 1]; const c = data[from + 2];
  const d = data[from + 4]; const e = data[from + 5]; const f = data[from + 6];
  const g = data[from + 8]; const h = data[from + 9]; const i = data[from + 10];
  // Columns (a b c), (d e f), (g h i): the inverse transpose is the cofactor matrix over the determinant.
  const A = e * i - f * h; const B = f * g - d * i; const C = d * h - e * g;
  const det = a * A + b * B + c * C || 1;
  const out = [
    A, B, C,
    c * h - b * i, a * i - c * g, b * g - a * h,
    b * f - c * e, c * d - a * f, a * e - b * d,
  ];
  for (let k = 0; k < 9; k++) data[to + k] = out[k] / det;
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
  for (const name of ['uView', 'uProj', 'uCrowd', 'uChair', 'uPass', 'uOutlineColour', 'uTex', 'uOutline', 'uPxScale', 'uColour', 'uDepth', 'uShapes', 'uShadow', 'uShadowAlpha', 'uEye']) {
    u[name] = gl.getUniformLocation(p, name);
  }
  return { program: p, u };
}

/** An off-screen picture with smooth edges: colour, depth and stencil, `samples` to a pixel. */
function target(gl, w, h, samples) {
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  const colour = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, colour);
  gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, w, h);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, colour);
  const depth = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
  gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH24_STENCIL8, w, h);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, depth);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, colour, depth };
}

/** An off-screen picture kept as textures, colour and depth (with stencil, to match), one sample to a pixel. */
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
  const depth = make(gl.DEPTH24_STENCIL8);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
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
