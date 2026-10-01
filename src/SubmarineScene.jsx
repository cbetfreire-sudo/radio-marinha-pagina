import React, { useEffect, useRef } from "react";

// Port do cenário do app (marinha_app/lib/components/radio_submarine):
// mesma malha do Riachuelo (variante S43, Almirante Karam), mesma câmera, mesmos
// rumos e a mesma esteira da hélice. As aeronaves do SuperCard Naval sobrevoam
// o alto da tela: o AF-1 Skyhawk, depois o UH-17, depois o AH-11B Super Lynx,
// depois o submarino cruza, um de cada vez, e a sequência recomeça.

const HULL_LENGTH = 71.62;
const HULL_BEAM = 6.2;
const FOCAL = 0.85;
const PROPELLER_X = -35.2;
const PROPELLER_Y = -1.5;
const PROPELLER_RADIUS = 2.2;
const PROPELLER_REVS = 1.75;
const PROPELLER_CENTER_Y = -1.55;
// Duração da travessia do submarino e do mar vazio depois de cada um que
// passa (veja SEQUENCE).
const CROSSING = 34;
const PAUSE = 10;
const RAMP_SECONDS = 1.8;
const BACKDROP_OPACITY = 0.85;
const DEFAULT_ACCENT = [0, 229, 255];

// ── Malha 3D ──────────────────────────────────────────────────────────────
//
// Um só programa desenha o submarino e as aeronaves. Cada modelo traz suas
// partes giratórias (hélice, rotor principal, Fenestron), com o eixo e o
// centro de giro do ship_mesh.dart, as partes que não aparecem na cena e o
// próprio jeito de ser iluminado.

const vertexSource = `
attribute vec3 aPosition;
attribute vec3 aNormal;
attribute vec3 aColor;
attribute vec3 aFaceNormal;
attribute float aBias;
uniform vec2 uSize;
uniform vec2 uCenter;
uniform float uScale;
uniform float uAzimuth;
uniform float uElevation;
uniform float uTrim;
uniform float uPitch;
uniform float uRoll;
uniform float uYaw;
uniform vec3 uPivot;
uniform float uSpinAxis;
uniform vec3 uSpinCenter;
uniform float uSpinAngle;
uniform float uExposure;
uniform vec3 uTint;
uniform vec3 uTintAmount;
varying vec3 vColor;
varying float vFacing;

// Giro em torno de X (1), Y (2) ou Z (3), com as mesmas contas do app.
vec3 turn(vec3 v, float axis, float angle) {
  float c = cos(angle), s = sin(angle);
  if (axis < 1.5) return vec3(v.x, v.y * c - v.z * s, v.y * s + v.z * c);
  if (axis < 2.5) return vec3(v.x * c - v.z * s, v.y, v.x * s + v.z * c);
  return vec3(v.x * c - v.y * s, v.x * s + v.y * c, v.z);
}

void main() {
  vec3 p = aPosition;
  vec3 n = aNormal;
  vec3 fn = aFaceNormal;
  if (uSpinAxis > 0.5) {
    p = turn(p - uSpinCenter, uSpinAxis, uSpinAngle) + uSpinCenter;
    n = turn(n, uSpinAxis, uSpinAngle);
    fn = turn(fn, uSpinAxis, uSpinAngle);
  }
  // Atitude de voo: inclinação lateral, arfagem e guinada, em torno do pivô.
  p = turn(turn(turn(p - uPivot, 1.0, uRoll), 3.0, uPitch), 2.0, uYaw);
  n = turn(turn(turn(n, 1.0, uRoll), 3.0, uPitch), 2.0, uYaw);
  fn = turn(turn(turn(fn, 1.0, uRoll), 3.0, uPitch), 2.0, uYaw);

  float ca = cos(uAzimuth), sa = sin(uAzimuth);
  float ce = cos(uElevation), se = sin(uElevation);
  vec3 view = vec3(sa * ce, se, ca * ce);
  vFacing = dot(fn, view);
  vec3 nn = normalize(n);
  float diffuse = max(0.0, dot(nn, vec3(-0.32, 0.83, 0.46)));
  vec3 shaded = aColor * (0.50 + diffuse * 0.50);
  // Luz do ambiente: a claridade da água (ou do céu) desce da superfície.
  // Ela tinge o que está voltado para cima, acende o dorso e marca só o
  // contorno de cima; a barriga, virada para o fundo, fica na sombra, sem
  // tom nem contorno, e um pouco mais escura que os costados.
  float up = clamp(nn.y * 0.5 + 0.5, 0.0, 1.0);
  float sky = max(0.0, nn.y);
  float rim = pow(1.0 - clamp(abs(dot(nn, view)), 0.0, 1.0), 2.5) * smoothstep(0.0, 0.6, nn.y);
  vec3 lit = shaded * uExposure * mix(0.7, 1.0, up);
  vColor = min(lit + uTint * (uTintAmount.x * up + uTintAmount.y * sky + uTintAmount.z * rim), 1.0);

  float horizontal = p.x * ca - p.z * sa;
  float vertical = p.x * sa * se - p.y * ce + p.z * ca * se;
  // As marcações rentes ao casco ganham um avanço, como o depthBias da
  // ordenação do app, e ele some nos ângulos rasantes.
  float depth = dot(p, view) + aBias * max(vFacing, 0.0);
  float ct = cos(uTrim), st = sin(uTrim);
  vec2 local = vec2(horizontal * ct - vertical * st, horizontal * st + vertical * ct);
  vec2 screen = uCenter + local * uScale;
  gl_Position = vec4(screen.x / uSize.x * 2.0 - 1.0,
                     1.0 - screen.y / uSize.y * 2.0,
                     -depth / 80.0, 1.0);
}`;

const fragmentSource = `
precision mediump float;
varying vec3 vColor;
varying float vFacing;
void main() {
  if (vFacing <= 0.000001) discard;
  gl_FragColor = vec4(vColor, 1.0);
}`;

const STRIDE = 13;
const AXIS = { x: 1, y: 2, z: 3 };

// Na página o fundo é mais escuro que no app e o grafite do casco virava um
// recorte preto: o submarino recebe a claridade azul que desce da superfície.
const SUBMARINE_MODEL = {
  url: "/imagens/riachuelo.mesh.json",
  variant: "S43",
  pivot: [0, 0, 0],
  spinners: [{ test: /propeller|helice/i, axis: "x", center: [0, PROPELLER_CENTER_Y, 0], speed: 1 }],
  exposure: 1.6,
  tint: [0.165, 0.561, 0.706],
  tintAmount: [0.12, 0.10, 0.35]
};

// UH-17 (H135, N-7091) do SuperCard Naval. Rotores como no ship_mesh.dart:
// o principal em Y sobre o mastro e o Fenestron em Z, 3,2 vezes mais rápido.
const HELICOPTER_MODEL = {
  url: "/imagens/uh17.mesh.json",
  pivot: [-0.36, 1.9, 0],
  spinners: [
    { test: /main_rotor_blade|rotor_head_fairing|blade_root_damper/i, axis: "y", center: [-0.36, 3.69, 0], speed: 1 },
    { test: /fenestron_blade/i, axis: "z", center: [-6.30, 1.86, 0], speed: 3.2 }
  ],
  exposure: 1.05,
  tint: [0.62, 0.74, 0.84],
  tintAmount: [0.03, 0.05, 0.16]
};

// AH-11B Super Lynx (Mk21B, N-4003) do SuperCard Naval. Cubos e velocidades
// do campo rotors da malha: o principal em Y sobre o mastro e o rotor de
// cauda, a bombordo, em Z. O trem do Lynx é fixo e fica à vista em voo.
const LYNX_MODEL = {
  url: "/imagens/ah11b.mesh.json",
  pivot: [0, 1.8, 0],
  spinners: [
    { test: /main_rotor_blade|rotor_head_fairing|blade_root_damper/i, axis: "y", center: [0, 3.39, 0], speed: 1 },
    { test: /tail_rotor_blade|tail_rotor_hub/i, axis: "z", center: [-7.33, 2.49, -0.47], speed: 3.4 }
  ],
  exposure: 1.05,
  tint: [0.62, 0.74, 0.84],
  tintAmount: [0.03, 0.05, 0.16]
};

// AF-1 Skyhawk (A-4KU, N-1001) do SuperCard Naval. A malha vem com o trem
// baixado; em voo ele fica recolhido, então rodas, pernas e portas (12_ e 13_)
// ficam de fora. Não há poços modelados: a barriga fica lisa.
const SKYHAWK_MODEL = {
  url: "/imagens/af1.mesh.json",
  pivot: [0, 2.0, 0],
  hidden: /^1[23]_/,
  spinners: [],
  exposure: 1.05,
  tint: [0.62, 0.74, 0.84],
  tintAmount: [0.03, 0.05, 0.16]
};

// Desindexa a malha: cada canto leva a normal geométrica da face, que decide o
// descarte das faces de costas exatamente como no app.
function buildGeometry(data, model) {
  const meshes = [...data.meshes, ...(model.variant ? data.variants?.[model.variant]?.meshes || [] : [])];
  const groups = [[], ...model.spinners.map(() => [])];
  for (const mesh of meshes) {
    if (model.hidden?.test(mesh.name || "")) continue;
    const spinner =model.spinners.findIndex(item => item.test.test(mesh.name || ""));
    const target = groups[spinner + 1];
    const color = data.materials[mesh.material].color;
    const bias = mesh.depthBias || 0;
    const { positions: p, indices, normals } = mesh;
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const magnitude = Math.hypot(nx, ny, nz);
      if (magnitude < 1e-7) continue;
      nx /= magnitude; ny /= magnitude; nz /= magnitude;
      for (const v of [a, b, c]) {
        target.push(
          p[v], p[v + 1], p[v + 2],
          normals ? normals[v] : nx, normals ? normals[v + 1] : ny, normals ? normals[v + 2] : nz,
          color[0], color[1], color[2],
          nx, ny, nz,
          bias
        );
      }
    }
  }
  return groups.map((group, index) => ({ data: new Float32Array(group), spinner: model.spinners[index - 1] || null }));
}

function compile(gl, type, source) {
  const item = gl.createShader(type);
  gl.shaderSource(item, source);
  gl.compileShader(item);
  if (!gl.getShaderParameter(item, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(item));
  return item;
}

function createRenderer(canvas) {
  const gl = canvas.getContext("webgl", { alpha: true, antialias: true, premultipliedAlpha: true });
  if (!gl) return null;
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);

  const attributes = [
    ["aPosition", 3, 0], ["aNormal", 3, 3], ["aColor", 3, 6], ["aFaceNormal", 3, 9], ["aBias", 1, 12]
  ].map(([name, size, offset]) => ({ location: gl.getAttribLocation(program, name), size, offset }));
  const uniforms = Object.fromEntries(
    ["Size", "Center", "Scale", "Azimuth", "Elevation", "Trim", "Pitch", "Roll", "Yaw", "Pivot",
      "SpinAxis", "SpinCenter", "SpinAngle", "Exposure", "Tint", "TintAmount"]
      .map(name => [name, gl.getUniformLocation(program, `u${name}`)])
  );
  const models = new Map();

  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.disable(gl.BLEND);
  gl.disable(gl.CULL_FACE);
  gl.clearColor(0, 0, 0, 0);

  return {
    add(model, data) {
      const parts = buildGeometry(data, model).filter(part => part.data.length).map(part => {
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, part.data, gl.STATIC_DRAW);
        return { buffer, count: part.data.length / STRIDE, spinner: part.spinner };
      });
      models.set(model, parts);
    },
    has(model) {
      return models.has(model);
    },
    // Cada item: { model, pass, angle } — angle é o giro acumulado da hélice
    // ou do rotor principal, em radianos.
    draw(items, width, height, ratio) {
      resize(canvas, width, height, ratio);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.uniform2f(uniforms.Size, width, height);
      for (const { model, pass, angle } of items) {
        const parts = models.get(model);
        if (!parts || !pass) continue;
        gl.uniform2f(uniforms.Center, pass.x, pass.y);
        gl.uniform1f(uniforms.Scale, pass.ppm);
        gl.uniform1f(uniforms.Azimuth, pass.azimuth);
        gl.uniform1f(uniforms.Elevation, pass.elevation);
        gl.uniform1f(uniforms.Trim, pass.trim || 0);
        gl.uniform1f(uniforms.Pitch, pass.pitch || 0);
        gl.uniform1f(uniforms.Roll, pass.roll || 0);
        gl.uniform1f(uniforms.Yaw, pass.yaw || 0);
        gl.uniform3fv(uniforms.Pivot, model.pivot);
        gl.uniform1f(uniforms.Exposure, model.exposure);
        gl.uniform3fv(uniforms.Tint, model.tint);
        gl.uniform3fv(uniforms.TintAmount, model.tintAmount);
        for (const part of parts) {
          gl.uniform1f(uniforms.SpinAxis, part.spinner ? AXIS[part.spinner.axis] : 0);
          gl.uniform3fv(uniforms.SpinCenter, part.spinner ? part.spinner.center : [0, 0, 0]);
          gl.uniform1f(uniforms.SpinAngle, part.spinner ? angle * part.spinner.speed : 0);
          gl.bindBuffer(gl.ARRAY_BUFFER, part.buffer);
          for (const attribute of attributes) {
            if (attribute.location < 0) continue;
            gl.enableVertexAttribArray(attribute.location);
            gl.vertexAttribPointer(attribute.location, attribute.size, gl.FLOAT, false, STRIDE * 4, attribute.offset * 4);
          }
          gl.drawArrays(gl.TRIANGLES, 0, part.count);
        }
      }
    },
    dispose() {
      models.forEach(parts => parts.forEach(part => gl.deleteBuffer(part.buffer)));
      gl.deleteProgram(program);
    }
  };
}

function resize(canvas, width, height, ratio) {
  const pixelWidth = Math.round(width * ratio), pixelHeight = Math.round(height * ratio);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
}

// ── Rumos (SubmarineCourse) ───────────────────────────────────────────────

const SIZE_SCALE = 2.0;

// [lane] é a altura da travessia em fração da tela. No app os rumos passam
// em torno de 0,42; aqui o sub vai mais fundo, logo acima do cartão de volume,
// e cada rumo mantém a mesma diferença de altura que tinha em relação aos outros.
// [scale] encolhe o casco quando a tela é mais larga que alta (veja layoutOf).
function randomCourse(lane = 0.42, scale = 1) {
  const mode = Math.floor(Math.random() * 5);
  const jitter = span => (Math.random() * 2 - 1) * span;
  const size = SIZE_SCALE * scale * (1 + jitter(0.10));
  const height = jitter(0.035);
  const edge = (x, base) => {
    const extra = (SIZE_SCALE - 1) / SIZE_SCALE * base * size / 2;
    return x < 0 ? x - extra : (x > 1 ? x + extra : x);
  };
  const course = { dive: 0, turnStart: 0, turnEnd: 1 };
  switch (mode) {
    case 0:
      return { ...course, entryX: edge(-0.34, 0.36), exitX: edge(1.40, 0.62), entrySize: 0.36 * size, exitSize: 0.62 * size, sightY: lane + height, elevation: 0.15 + jitter(0.02), turn: -0.26 + jitter(0.06) };
    case 1:
      return { ...course, entryX: edge(1.34, 0.36), exitX: edge(-0.40, 0.62), entrySize: 0.36 * size, exitSize: 0.62 * size, sightY: lane + height, elevation: 0.15 + jitter(0.02), turn: 0.26 + jitter(0.06) };
    case 2:
      return { ...course, entryX: 0.24 + jitter(0.06), exitX: edge(1.46, 0.60), entrySize: 0.30 * size, exitSize: 0.60 * size, sightY: lane - 0.02 + height, elevation: 0.11 + jitter(0.02), turn: -0.78 + jitter(0.10) };
    case 4:
      return { ...course, entryX: 0.44 + jitter(0.02), exitX: edge(1.45, 0.75), entrySize: 0.24 * size, exitSize: 0.75 * size, sightY: lane - 0.02 + height, elevation: 0.11 + jitter(0.02), turn: -1.55 + jitter(0.05), turnStart: 0.35, turnEnd: 0.78 };
    default:
      return { ...course, entryX: edge(-0.32, 0.38), exitX: edge(1.38, 0.56), entrySize: 0.38 * size, exitSize: 0.56 * size, sightY: lane - 0.07 + height, elevation: 0.09 + jitter(0.02), turn: -0.16 + jitter(0.06), dive: 0.042 + jitter(0.012) };
  }
}

const isArc = course => course.turnStart <= 0 && course.turnEnd >= 1;

function turnDone(course, u) {
  if (isArc(course)) return u;
  const x = Math.max(0, Math.min(1, (u - course.turnStart) / (course.turnEnd - course.turnStart)));
  return x * x * (3 - 2 * x);
}

function swept(course, u) {
  const steps = 96, du = u / steps;
  let x = 0, z = 0;
  for (let k = 0; k < steps; k += 1) {
    const turned = course.turn * turnDone(course, (k + 0.5) * du);
    x += Math.sin(turned) * du;
    z += Math.cos(turned) * du;
  }
  return [x, z];
}

// ── Instante da travessia (SubmarinePass) ─────────────────────────────────

function passAt(width, height, course, t, length = HULL_LENGTH) {
  const f = FOCAL * width;
  const beta = course.elevation + Math.atan((0.5 - course.sightY) * height / f);
  const cosB = Math.cos(beta), sinB = Math.sin(beta);
  const zcEntry = FOCAL * length / course.entrySize;
  const zcExit = FOCAL * length / course.exitSize;
  const zcMid = (zcEntry + zcExit) / 2;
  const depth = zcMid / (cosB + Math.tan(course.elevation) * sinB) * Math.tan(course.elevation);
  const zEntry = (zcEntry - depth * sinB) / cosB;
  const zExit = (zcExit - depth * sinB) / cosB;
  const xEntry = (course.entryX - 0.5) * width * zcEntry / f;
  const xExit = (course.exitX - 0.5) * width * zcExit / f;
  const chordX = xExit - xEntry, chordZ = zExit - zEntry;
  const chord = Math.hypot(chordX, chordZ);

  let s, heading, x, z;
  if (isArc(course)) {
    const half = course.turn / 2;
    const path = Math.abs(half) < 1e-4 ? chord : chord * half / Math.sin(half);
    const heading0 = Math.atan2(chordX, chordZ) - half;
    const kappa = course.turn / path;
    s = path * t;
    heading = heading0 + kappa * s;
    if (Math.abs(kappa) < 1e-6) {
      x = xEntry + s * Math.sin(heading0);
      z = zEntry + s * Math.cos(heading0);
    } else {
      x = xEntry + (Math.cos(heading0) - Math.cos(heading)) / kappa;
      z = zEntry + (Math.sin(heading) - Math.sin(heading0)) / kappa;
    }
  } else {
    const [sweptX, sweptZ] = swept(course, 1);
    const path = chord / Math.hypot(sweptX, sweptZ);
    const heading0 = Math.atan2(chordX, chordZ) - Math.atan2(sweptX, sweptZ);
    const [doneX, doneZ] = swept(course, t);
    const sin0 = Math.sin(heading0), cos0 = Math.cos(heading0);
    s = path * t;
    heading = heading0 + course.turn * turnDone(course, t);
    x = xEntry + path * (sin0 * doneZ + cos0 * doneX);
    z = zEntry + path * (cos0 * doneZ - sin0 * doneX);
  }

  const d = depth + s * Math.tan(course.dive);
  const elevation = Math.atan2(d, z);
  const zc = z * cosB + d * sinB;
  const azimuth = heading - Math.PI / 2;
  const alongScreen = Math.cos(azimuth) * Math.cos(elevation);
  const trim = (course.dive + Math.sin(t * 2 * Math.PI + course.entryX) * 0.004) * alongScreen;
  const edge = Math.max(0, Math.min(1, Math.min(t, 1 - t) / 0.05));
  const haze = Math.max(0.55, Math.min(1, 1 - (zc - 110) / 600));

  return makePass({
    ppm: f / zc,
    x: width / 2 + f * x / zc,
    y: height / 2 - f * Math.tan(beta - elevation),
    azimuth,
    elevation,
    trim,
    heading,
    travelled: s,
    zc,
    opacity: edge * haze
  });
}

function makePass(pass) {
  const sa = Math.sin(pass.azimuth), ca = Math.cos(pass.azimuth);
  const se = Math.sin(pass.elevation), ce = Math.cos(pass.elevation);
  const ct = Math.cos(pass.trim), st = Math.sin(pass.trim);
  pass.point = (along, above = 0, lateral = 0) => {
    const dx = along * ca - lateral * sa;
    const dy = along * sa * se - above * ce + lateral * ca * se;
    return [pass.x + (dx * ct - dy * st) * pass.ppm, pass.y + (dx * st + dy * ct) * pass.ppm];
  };
  pass.depth = (along, above, lateral) => along * sa * ce + above * se + lateral * ca * ce;
  pass.broadside = Math.abs(ca);
  return pass;
}

// ── Sombra e esteira (UnderwaterBackgroundPainter) ────────────────────────

const BLADES = 5;
const FILAMENT_AGE = 0.42;
const MAX_AGE = 3.0;
const BUBBLE_STEP = 0.016;
const ASTERN = 8.5;

function noise(a, b, salt) {
  let h = Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(salt, 83492791);
  h = Math.imul(h ^ (h >> 13), 1274126177);
  h ^= h >> 16;
  return (h & 0xffff) / 0xffff;
}

const rgba = (rgb, alpha) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${Math.max(0, Math.min(1, alpha))})`;

// Equivalente ao MaskFilter.blur: a forma é desenhada fora da tela e só a
// sombra dela, desfocada, cai no lugar. Funciona em qualquer navegador.
function blurred(ctx, ratio, sigma, color, draw) {
  const offscreen = ctx.canvas.width / ratio * 2 + sigma * 4 + 1000;
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = sigma * 2 * ratio;
  ctx.shadowOffsetX = offscreen * ratio;
  ctx.translate(-offscreen, 0);
  ctx.fillStyle = "#000";
  draw();
  ctx.restore();
}

function drawShadow(ctx, ratio, pass) {
  const width = (HULL_LENGTH * pass.broadside + HULL_BEAM) * pass.ppm;
  const height = Math.max(HULL_BEAM * pass.ppm, width * 0.11);
  blurred(ctx, ratio, height * 0.55, `rgba(0,0,0,${0.16 * Math.max(0, Math.min(1, pass.opacity))})`, () => {
    ctx.beginPath();
    ctx.ellipse(pass.x, pass.y + height * 0.85, width / 2, height / 2, 0, 0, Math.PI * 2);
    ctx.fill();
  });
}

function drawWake(ctx, ratio, width, pass, now, accent) {
  const hub = pass.point(PROPELLER_X, PROPELLER_Y);
  if (hub[0] < -width * 0.4 || hub[0] > width * 1.4 || pass.opacity < 0.02) return;

  const ppm = pass.ppm;
  const strength = Math.max(0, Math.min(1, pass.opacity));
  const omega = PROPELLER_REVS * 2 * Math.PI;
  const foam = accent.map(c => Math.round(255 + (c - 255) * 0.3));
  const hubDepth = pass.depth(PROPELLER_X, PROPELLER_Y, 0);
  const aft = age => 0.7 + ASTERN * age * (1 - 0.25 * age / MAX_AGE);
  const spread = age => PROPELLER_RADIUS * (0.9 - 0.12 * Math.min(age / 0.3, 1)) + 0.5 * age * age;
  const swirl = age => 1.1 * (1 - Math.exp(-1.6 * age));
  const facing = (along, above, lateral, r) =>
    0.6 + 0.4 * Math.max(-1, Math.min(1, (pass.depth(along, above, lateral) - hubDepth) / Math.max(r, 0.5)));

  // 1. Véu de água revolvida, mais claro junto às pás.
  const start = pass.point(PROPELLER_X - 0.5, PROPELLER_Y);
  const end = pass.point(PROPELLER_X - aft(MAX_AGE * 0.7), PROPELLER_Y);
  const axisX = end[0] - start[0], axisY = end[1] - start[1];
  const axisLength = Math.hypot(axisX, axisY);
  if (axisLength > 1) {
    const nx = -axisY / axisLength, ny = axisX / axisLength;
    const r0 = spread(0.15) * ppm * 0.85;
    const r1 = spread(MAX_AGE * 0.7) * ppm * 0.9;
    const gradient = ctx.createLinearGradient(start[0], start[1], end[0], end[1]);
    gradient.addColorStop(0, `rgba(0,0,0,${0.13 * strength})`);
    gradient.addColorStop(0.35, `rgba(0,0,0,${0.035 * strength})`);
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    blurred(ctx, ratio, Math.max(2, r0 * 0.8), rgba(foam, 1), () => {
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.moveTo(start[0] + nx * r0, start[1] + ny * r0);
      ctx.lineTo(end[0] + nx * r1, end[1] + ny * r1);
      ctx.lineTo(end[0] - nx * r1, end[1] - ny * r1);
      ctx.lineTo(start[0] - nx * r0, start[1] - ny * r0);
      ctx.closePath();
      ctx.fill();
    });
  }

  // 2. Manchas difusas: a água revolvida ganha corpo e se abre.
  const puffStep = 0.22;
  for (let k = Math.ceil((now - MAX_AGE) / puffStep); k <= Math.floor(now / puffStep); k += 1) {
    if (k < 0) continue;
    const age = now - (k + 0.8 * noise(k, 7, 11)) * puffStep;
    if (age < 0.15 || age > MAX_AGE) continue;
    const n = noise(k, 3, 13);
    const theta = n * 2 * Math.PI;
    const r = spread(age) * 0.55 * noise(k, 5, 17);
    const p = pass.point(PROPELLER_X - aft(age), PROPELLER_Y + r * Math.cos(theta) + 0.15 * age * age, r * Math.sin(theta));
    const blob = (0.5 + 0.45 * age) * ppm * (0.7 + 0.6 * n);
    const alpha = strength * 0.075 * Math.min((age - 0.15) / 0.2, 1) * (1 - age / MAX_AGE);
    blurred(ctx, ratio, blob * 0.7, rgba(foam, alpha), () => {
      ctx.beginPath();
      ctx.arc(p[0], p[1], blob, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // 3. Filamentos das pontas das pás, em espiral, que se partem em pedaços.
  ctx.lineCap = "round";
  const samples = 36;
  for (let blade = 0; blade < BLADES; blade += 1) {
    const offset = blade * 2 * Math.PI / BLADES;
    let previous = null;
    for (let i = 0; i <= samples; i += 1) {
      const age = i / samples * FILAMENT_AGE;
      const theta = omega * (now - age) + offset + swirl(age);
      const r = spread(age);
      const along = PROPELLER_X - aft(age);
      const above = PROPELLER_Y + r * Math.cos(theta);
      const lateral = r * Math.sin(theta);
      const p = pass.point(along, above, lateral);
      const piece = Math.floor((now - age) / 0.045);
      const broken = age > 0.1 && noise(blade, piece, 21) < (age - 0.1) * 2.6;
      if (previous && !broken) {
        const life = 1 - age / FILAMENT_AGE;
        ctx.lineWidth = Math.max(0.45, (0.035 + 0.05 * life) * ppm);
        ctx.strokeStyle = rgba(foam, strength * 0.36 * life * facing(along, above, lateral, r));
        ctx.beginPath();
        ctx.moveTo(previous[0], previous[1]);
        ctx.lineTo(p[0], p[1]);
        ctx.stroke();
      }
      previous = broken ? null : p;
    }
  }

  // 4. Nuvem de bolhas, em aglomerados, que o jato abre e o empuxo faz subir.
  const newest = Math.floor(now / BUBBLE_STEP);
  for (let k = Math.max(0, Math.ceil((now - MAX_AGE) / BUBBLE_STEP)); k <= newest; k += 1) {
    const born = (k + noise(k, 1, 31)) * BUBBLE_STEP;
    const age = now - born;
    if (age < 0.08 || age > MAX_AGE) continue;
    const cluster = noise(Math.floor(born / 0.14), 2, 37);
    if (noise(k, 3, 41) > 0.35 + 0.65 * cluster) continue;
    if (noise(k, 4, 43) < age / MAX_AGE * 0.55) continue;
    const n1 = noise(k, 5, 47), n2 = noise(k, 6, 53), n3 = noise(k, 7, 59), n4 = noise(k, 8, 61);
    const fromTip = n1 < 0.55;
    const blade = Math.floor(n2 * BLADES);
    const theta = fromTip
      ? omega * born + blade * 2 * Math.PI / BLADES + swirl(age)
      : n2 * 2 * Math.PI + swirl(age);
    const r0 = fromTip ? 1 : Math.sqrt(n3) * 0.85;
    const drift = Math.sqrt(age) * 0.9;
    const r = spread(age) * r0 + (n4 - 0.5) * drift;
    const along = PROPELLER_X - aft(age) + (n3 - 0.5) * drift * 2.2;
    const above = PROPELLER_Y + r * Math.cos(theta) + 0.18 * age * age * (0.5 + n1);
    const lateral = r * Math.sin(theta) + (n2 - 0.5) * drift;
    const p = pass.point(along, above, lateral);
    const sizeM = (0.035 + 0.07 * n4 ** 3) * (1 + 0.8 * age) * (0.8 + 0.4 * n1);
    const alpha = strength
      * Math.min((age - 0.08) / 0.1, 1)
      * (1 - age / MAX_AGE) ** 1.4
      * facing(along, above, lateral, Math.max(r, 0.5))
      * (0.45 + 0.35 * n3);
    ctx.fillStyle = rgba(foam, alpha);
    ctx.beginPath();
    ctx.arc(p[0], p[1], Math.max(sizeM * ppm, 0.5), 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawBackdrop(canvas, width, height, ratio, paint) {
  resize(canvas, width, height, ratio);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  paint(ctx);
}

function parseAccent(value) {
  if (!value) return DEFAULT_ACCENT;
  const parts = String(value).split(",").map(part => Number(part.trim()));
  return parts.length === 3 && parts.every(Number.isFinite) ? parts : DEFAULT_ACCENT;
}

// Curves.easeInOut do Flutter: cubic-bezier(0.42, 0, 0.58, 1).
function easeInOut(x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let lo = 0, hi = 1, u = x;
  for (let i = 0; i < 20; i += 1) {
    u = (lo + hi) / 2;
    const bx = 3 * (1 - u) * (1 - u) * u * 0.42 + 3 * (1 - u) * u * u * 0.58 + u * u * u;
    if (bx < x) lo = u; else hi = u;
  }
  return 3 * (1 - u) * u * u + u * u * u;
}

// ── Sobrevoo do Skyhawk, do UH-17 e do Super Lynx ─────────────────────────
//
// Antes de cada travessia do submarino, o Skyhawk, o UH-17 e o Super Lynx
// cruzam a tela, um de cada vez, e cada um faz uma manobra no caminho. A
// derrota usa a mesma física da travessia do submarino (velocidade constante
// sobre um arco, câmera de furo de agulha), só que acima da câmera: vê-se a
// aeronave um pouco de baixo, inclinando nas curvas.

// Sobe e desce devagar nas pontas: derivada nula em 0 e em 1.
const ease = x => x - Math.sin(2 * Math.PI * x) / (2 * Math.PI);
const bump = x => Math.sin(Math.PI * x) ** 2;
const LOOP_RADIUS = 5.5;

// Manobras. [duration] em segundos; [speed(x)], com x de 0 a 1 ao longo da
// manobra, é a fração da velocidade de cruzeiro com que a derrota anda (1 se
// omitida); [rise] é quanto ela sobe acima da derrota e [sweep], quanto se
// afasta dela para frente ou para trás, em metros, para caber na faixa e na
// tela; [pose(x, dir)] dá os giros (roll, pitch, yaw, em radianos) e os
// deslocamentos na referência do rumo (along, above, lateral, em metros).
// [dir] é o lado, sorteado a cada voo.
const MANEUVERS = {
  // Tonneau: um giro completo em torno do eixo longitudinal.
  roll: {
    duration: 1.6,
    pose: (x, dir) => ({ roll: dir * 2 * Math.PI * ease(x), pitch: 0.05 * bump(x) })
  },
  // Dois tonneaux seguidos.
  doubleRoll: {
    duration: 2.6,
    pose: (x, dir) => ({ roll: dir * 4 * Math.PI * ease(x), pitch: 0.06 * bump(x) })
  },
  // Tonneau barril: gira enquanto descreve uma hélice em volta da derrota,
  // com o dorso sempre voltado para o centro dela.
  barrelRoll: {
    duration: 2.6,
    rise: 3.6,
    pose: (x, dir) => {
      const phi = 2 * Math.PI * ease(x);
      return { roll: dir * phi, pitch: 0.28 * Math.sin(phi), above: 1.8 * (1 - Math.cos(phi)), lateral: -dir * 1.8 * Math.sin(phi) };
    }
  },
  // Looping: cabra até passar de dorso pelo alto e volta à derrota. A derrota
  // quase para enquanto isso, e o avião segue em frente ao terminar.
  loop: {
    duration: 3.6,
    rise: 2 * LOOP_RADIUS,
    sweep: LOOP_RADIUS,
    speed: x => (1 + Math.cos(2 * Math.PI * x)) / 2,
    pose: x => {
      const theta = 2 * Math.PI * ease(x);
      return { pitch: theta, along: LOOP_RADIUS * Math.sin(theta), above: LOOP_RADIUS * (1 - Math.cos(theta)) };
    }
  },
  // Cumprimento com as asas: três balanços de um lado para o outro.
  wingRock: {
    duration: 2.2,
    pose: (x, dir) => ({ roll: dir * 0.8 * Math.sin(6 * Math.PI * x) * Math.sin(Math.PI * x) })
  },
  // Pirueta: o helicóptero gira em torno do mastro sem sair da derrota.
  pirouette: {
    duration: 2.8,
    speed: x => 1 - 0.5 * bump(x),
    pose: (x, dir) => ({ yaw: dir * 2 * Math.PI * ease(x) })
  },
  // Parada com pirueta: cabra para frear, para no ar, gira no lugar e
  // arranca de nariz baixo.
  hoverPirouette: {
    duration: 6,
    speed: x => (x < 0.22 ? Math.cos(Math.PI / 2 * x / 0.22) ** 2 : x > 0.78 ? Math.sin(Math.PI / 2 * (x - 0.78) / 0.22) ** 2 : 0),
    pose: (x, dir) => {
      const flare = x < 0.22 ? 0.32 * Math.sin(Math.PI * x / 0.22) : 0;
      const dash = x > 0.78 ? -0.28 * Math.sin(Math.PI * (x - 0.78) / 0.22) : 0;
      const hover = Math.min(1, Math.max(0, Math.min(x / 0.22, (1 - x) / 0.22)));
      const spin = Math.max(0, Math.min(1, (x - 0.28) / 0.44));
      return { pitch: flare + dash + 0.06 * hover, yaw: dir * 2 * Math.PI * ease(spin) };
    }
  },
  // Reverência: reduz e abaixa o nariz, como quem cumprimenta.
  bow: {
    duration: 2.6,
    speed: x => 1 - 0.75 * bump(x),
    pose: x => ({ pitch: -0.42 * bump(x) })
  },
  // Balanço de um lado para o outro, como um aceno.
  sway: {
    duration: 2.4,
    pose: (x, dir) => ({ roll: dir * 0.38 * Math.sin(4 * Math.PI * x) * Math.sin(Math.PI * x) })
  }
};

// [length] é o comprimento em metros. [duration] é o tempo da travessia, da
// entrada à saída de cena. [scale] é o tamanho na tela, o único ajuste para
// deixá-la maior ou menor; a distância e a perspectiva saem daí. [revs] são
// as rotações do rotor (ou da hélice) por segundo; [pitch], a arfagem de
// cruzeiro (o helicóptero vai de nariz baixo, o jato com o nariz um pouco
// acima); [bank] realça a inclinação da curva, até [maxBank]; [bob] é o
// balanço vertical, em metros. [maneuvers] é o repertório de onde sai a
// manobra de cada passagem. [exhaust], quando há, é a saída do bocal do
// motor: o centro e o raio interno, em metros, do generate_af1.mjs.
const HELICOPTER = {
  model: HELICOPTER_MODEL, label: "helicóptero", length: 11.7, duration: 15, scale: 1.6, revs: 2.3, pitch: -0.06, bank: 4, maxBank: 0.26, bob: 0.18,
  maneuvers: ["pirouette", "hoverPirouette", "bow", "sway"]
};
const LYNX = {
  model: LYNX_MODEL, label: "Super Lynx", length: 13.3, duration: 15, scale: 1.6, revs: 2.0, pitch: -0.06, bank: 4, maxBank: 0.26, bob: 0.18,
  maneuvers: ["pirouette", "hoverPirouette", "bow", "sway"]
};
const SKYHAWK = {
  model: SKYHAWK_MODEL, label: "Skyhawk", length: 12.59, duration: 9, scale: 1.6, revs: 0, pitch: 0.03, bank: 12, maxBank: 0.6, bob: 0.05,
  maneuvers: ["roll", "doubleRoll", "barrelRoll", "loop", "wingRock"],
  exhaust: { at: [-6.29, 2.04, 0], radius: 0.32 }
};
const SUBMARINE = { model: SUBMARINE_MODEL, label: "submarino", duration: CROSSING, revs: PROPELLER_REVS };

// Ordem da cena: o AF-1, o UH-17, o AH-11B e o submarino, um de cada vez, com
// o mar vazio por PAUSE segundos depois de cada um; então a sequência recomeça.
const SEQUENCE = [SKYHAWK, HELICOPTER, LYNX, SUBMARINE];
// A página abre com o AF-1 já um pouco dentro da tela, parado até o rádio
// tocar; a manobra dele fica para depois desse instante.
const OPENING = 0.3 * SKYHAWK.duration;

// [lane] vem de layoutOf: o centro da capa do álbum, na altura do qual a
// aeronave voa, passando por trás dela como por trás de um prédio (cover);
// o teto, para o rotor ou a deriva não serem cortados no alto da coluna
// (ceiling), e o piso, acima do topo da vela do submarino (floor), todos em
// fração da altura; a caixa da capa (box), a proporção da tela e a escala.
// [previous] é a manobra da passagem anterior desta aeronave, que não se
// repete em seguida.
function randomFlight(aircraft, lane = { cover: 0.2, ceiling: 0.01, floor: 0.5, aspect: 0.6, scale: 1 }, previous = null) {
  const jitter = span => (Math.random() * 2 - 1) * span;
  const size = aircraft.scale * lane.scale * (1 + jitter(0.12));
  const below = () => lane.cover + jitter(0.015);
  const offLeft = s => -s / 2 - 0.04;
  const offRight = s => 1 + s / 2 + 0.04;
  const kinds = aircraft.maneuvers.filter(kind => kind !== previous);
  const maneuver = { kind: kinds[Math.floor(Math.random() * kinds.length)], dir: Math.random() < 0.5 ? -1 : 1, pick: Math.random() };
  const course = { aircraft, maneuver, box: lane.box, dive: jitter(0.02), turnStart: 0, turnEnd: 1, ceilY: lane.ceiling, floorY: lane.floor };
  // Sempre entra e sai pelas bordas, já grande: nascendo ao longe no meio da
  // tela, pequeno e escondido atrás da capa, ele passava despercebido.
  const entry = 0.26 * size, exit = 0.34 * size;
  const nearEntry = 0.22 * size, nearExit = 0.42 * size;
  switch (Math.floor(Math.random() * 4)) {
    // Través, da esquerda para a direita, aproximando-se aos poucos.
    case 0:
      return { ...course, entryX: offLeft(entry), exitX: offRight(exit), entrySize: entry, exitSize: exit, sightY: below(), elevation: -0.05 + jitter(0.02), turn: -0.20 + jitter(0.08) };
    // O espelho: da direita para a esquerda.
    case 1:
      return { ...course, entryX: offRight(entry), exitX: offLeft(exit), entrySize: entry, exitSize: exit, sightY: below(), elevation: -0.05 + jitter(0.02), turn: 0.20 + jitter(0.08) };
    // Entra mais longe pela esquerda e guina na direção da câmera, passando
    // perto antes de sair pela direita.
    case 2:
      return { ...course, entryX: offLeft(nearEntry), exitX: offRight(nearExit), entrySize: nearEntry, exitSize: nearExit, sightY: below(), elevation: -0.04 + jitter(0.01), turn: -0.60 + jitter(0.10), turnStart: 0.20, turnEnd: 0.75 };
    // O espelho: pela direita, saindo pela esquerda.
    default:
      return { ...course, entryX: offRight(nearEntry), exitX: offLeft(nearExit), entrySize: nearEntry, exitSize: nearExit, sightY: below(), elevation: -0.04 + jitter(0.01), turn: 0.60 + jitter(0.10), turnStart: 0.20, turnEnd: 0.75 };
  }
}

// Fração do espaço que a aeronave e a manobra ocupam quando ela está em [u]
// que fica à vista: dentro da tela e fora de trás da capa.
function visibleShare(width, height, flight, u) {
  const { length } = flight.aircraft;
  const move = MANEUVERS[flight.maneuver.kind];
  const q = passAt(width, height, flight, u, length);
  const half = (0.5 * length * Math.max(0.4, q.broadside) + (move.sweep || 0)) * q.ppm;
  const space = [q.x - half, q.y - (0.2 * length + (move.rise || 0)) * q.ppm, q.x + half, q.y + 0.2 * length * q.ppm];
  const area = r => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
  const clip = (r, c) => [Math.max(r[0], c[0]), Math.max(r[1], c[1]), Math.min(r[2], c[2]), Math.min(r[3], c[3])];
  const onScreen = clip(space, [0, 0, width, height]);
  let seen = area(onScreen);
  const box = flight.box;
  if (box) seen -= area(clip(onScreen, [box.left * width, box.top * height, box.right * width, box.bottom * height]));
  return seen / area(space);
}

// Marca a hora da manobra: onde a aeronave fica mais à vista pelo tempo que
// ela dura — no celular, a capa esconde o meio da tela. A travessia continua
// com a mesma duração: se a manobra freia a derrota, o cruzeiro acelera um
// pouco para compensar. Com [notBefore], a manobra só começa depois desse
// instante.
function schedule(width, height, flight) {
  const { aircraft, maneuver } = flight;
  const move = MANEUVERS[maneuver.kind];
  const total = aircraft.duration, span = move.duration;
  const speed = move.speed || (() => 1);
  const steps = 64, table = [0];
  for (let i = 1; i <= steps; i += 1) table.push(table[i - 1] + (speed((i - 1) / steps) + speed(i / steps)) / (2 * steps));
  const mean = table[steps];
  const cruise = 1 / (total - span + mean * span);
  const reach = cruise * span * mean;
  const seen = Array.from({ length: 101 }, (_, k) => visibleShare(width, height, flight, k / 100));
  const earliest = Math.max(0.3, flight.notBefore || 0);
  const options = [];
  for (let k = 12; k <= 88; k += 1) {
    const center = k / 100;
    const begin = center / cruise - span * mean / 2;
    if (begin < earliest || begin + span > total - 0.3) continue;
    const from = Math.max(0, Math.floor((center - reach / 2 - 0.02) * 100));
    const to = Math.min(100, Math.ceil((center + reach / 2 + 0.02) * 100));
    let sum = 0;
    for (let j = from; j <= to; j += 1) sum += seen[j];
    options.push({ begin, score: sum / (to - from + 1) });
  }
  const best = Math.max(0, ...options.map(option => option.score));
  const good = options.filter(option => option.score >= best * 0.85);
  const begin = good.length ? good[Math.floor(maneuver.pick * good.length)].begin : Math.max(earliest, (total - span) / 2);
  flight.plan = { begin, span, cruise, mean, table, from: cruise * begin, to: cruise * (begin + span * mean) };
}

// Quanto da derrota já foi percorrido [elapsed] segundos depois da entrada.
function progress(flight, elapsed) {
  const { begin, span, cruise, mean, table } = flight.plan;
  if (elapsed <= begin) return Math.max(0, cruise * elapsed);
  if (elapsed >= begin + span) return Math.min(1, cruise * (elapsed - span + mean * span));
  const at = (elapsed - begin) / span * (table.length - 1), i = Math.floor(at);
  const done = table[i] + (table[Math.min(i + 1, table.length - 1)] - table[i]) * (at - i);
  return cruise * (begin + span * done);
}

// Encaixa o voo na faixa dele: se a aeronave descer até a faixa do
// submarino, sobe a derrota; se o rotor ou a deriva passar do alto da coluna
// — contando o que a manobra sobe —, desce; e, se não couber nas duas coisas,
// encolhe a aeronave — ou seja, afasta-a da câmera. Perto da câmera ela sobe
// na tela, então é o trajeto visível inteiro que decide.
function clearance(width, height, flight) {
  const ceiling = (flight.ceilY ?? 0) * height;
  const floor = (flight.floorY ?? 1) * height;
  const rise = MANEUVERS[flight.maneuver.kind].rise || 0;
  const { from, to } = flight.plan;
  let drop = 0;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    let top = Infinity, bottom = -Infinity;
    for (let k = 0; k <= 24; k += 1) {
      const u = k / 24;
      const q = passAt(width, height, flight, u, flight.aircraft.length);
      const length = q.ppm * flight.aircraft.length;
      if (q.x + length / 2 < 0 || q.x - length / 2 > width) continue;
      const lift = u > from - 0.05 && u < to + 0.05 ? rise * q.ppm : 0;
      top = Math.min(top, q.y - 0.2 * length - lift);
      bottom = Math.max(bottom, q.y + 0.2 * length);
    }
    if (!Number.isFinite(top)) break;
    drop = Math.min(0, floor - bottom);
    if (top + drop < ceiling) drop = ceiling - top;
    if (bottom + drop <= floor + 0.5 || floor <= ceiling) break;
    const shrink = Math.max(0.5, Math.min(0.97, (floor - ceiling) / (bottom - top)));
    flight.entrySize *= shrink;
    flight.exitSize *= shrink;
  }
  return drop;
}

// Hora da manobra e encaixe na faixa, uma vez por voo e tamanho de tela.
function prepare(width, height, flight) {
  const key = `${width}x${height}`;
  if (flight.key === key) return;
  flight.key = key;
  schedule(width, height, flight);
  flight.drop = clearance(width, height, flight);
}

// A aeronave [elapsed] segundos depois de entrar em cena.
function flightAt(width, height, flight, elapsed) {
  const { length, duration, pitch, bank, maxBank, bob } = flight.aircraft;
  prepare(width, height, flight);
  const u = progress(flight, elapsed);
  const pass = passAt(width, height, flight, u, length);
  pass.y += flight.drop;
  // Inclinação lateral da curva coordenada, tan φ = v·ω/g, realçada para
  // aparecer no tamanho da tela.
  const dt = 0.08, other = elapsed + dt <= duration ? elapsed + dt : elapsed - dt;
  const next = passAt(width, height, flight, progress(flight, other), length);
  const omega = (next.heading - pass.heading) / (other - elapsed);
  const speed = Math.abs(next.travelled - pass.travelled) / dt;
  pass.roll = Math.max(-maxBank, Math.min(maxBank, Math.atan(speed * omega / 9.81) * bank));
  pass.pitch = pitch + Math.sin(elapsed * 0.9) * 0.01;
  pass.yaw = 0;
  pass.trim = 0;
  pass.y += Math.sin(elapsed * 1.1) * bob * pass.ppm;
  // Surge e some pelas bordas com mais calma que o submarino, cujo voo é
  // mais longo.
  pass.opacity = Math.max(0, Math.min(1, Math.min(u, 1 - u) / 0.08));

  const { begin, span } = flight.plan;
  const x = (elapsed - begin) / span;
  if (x > 0 && x < 1) {
    const move = MANEUVERS[flight.maneuver.kind].pose(x, flight.maneuver.dir);
    pass.roll += move.roll || 0;
    pass.pitch += move.pitch || 0;
    pass.yaw += move.yaw || 0;
    const along = move.along || 0, above = move.above || 0, lateral = move.lateral || 0;
    if (along || above || lateral) {
      // Sai da derrota: o centro vai para o ponto deslocado e o tamanho
      // acompanha o quanto ele chegou mais perto da câmera.
      const [px, py] = pass.point(along, above, lateral);
      const nearer = pass.depth(along, above, lateral);
      pass.x = px;
      pass.y = py;
      pass.ppm *= pass.zc / Math.max(pass.zc * 0.5, pass.zc - nearer);
    }
  }
  return pass;
}

// Lado da tela por onde um rumo entra ou sai; nulo quando ele surge ou some
// ao longe, no meio da tela.
const side = x => (x < 0 ? "left" : x > 1 ? "right" : null);

// Sorteia de novo enquanto o rumo entrar pelo lado por onde o anterior saiu:
// a aeronave não pode surgir no ponto em que o submarino ou a outra aeronave
// acabou de sumir, como se um tivesse virado o outro. Só vale para as
// aeronaves: aplicada também ao submarino, a regra prendia todos num sentido só.
function awayFrom(avoid, make) {
  let item = make();
  for (let tries = 0; avoid && side(item.entryX) === avoid && tries < 20; tries += 1) item = make();
  return item;
}

// ── Escapamento do AF-1 ───────────────────────────────────────────────────
//
// O J52 do Skyhawk não tem pós-combustor: do bocal sai um jato quente curto,
// alaranjado, e o rastro de fumaça clara pelo qual o A-4 era conhecido. O
// jato vai preso ao avião; o rastro fica no ar onde nasceu, então acompanha a
// curva da derrota e fica para trás enquanto se desfaz. Os dois ficam atrás
// do avião, como a esteira fica atrás do casco.

const EXHAUST_STEP = 0.018;
const EXHAUST_LIFE = 2.4;
const EXHAUST_HOT = [255, 200, 140];
const EXHAUST_SMOKE = [196, 208, 220];

// Ponto do corpo da aeronave (eixos do modelo, em metros) na tela, com a
// atitude que o shader aplica: inclinação lateral, arfagem e guinada, em
// torno do pivô.
function bodyPoint(pass, pivot, x, y, z) {
  const roll = pass.roll || 0, pitch = pass.pitch || 0, yaw = pass.yaw || 0;
  const px = x - pivot[0], py = y - pivot[1], pz = z - pivot[2];
  const rolledY = py * Math.cos(roll) - pz * Math.sin(roll);
  const rolledZ = py * Math.sin(roll) + pz * Math.cos(roll);
  const pitchedX = px * Math.cos(pitch) - rolledY * Math.sin(pitch);
  const pitchedY = px * Math.sin(pitch) + rolledY * Math.cos(pitch);
  return pass.point(pitchedX * Math.cos(yaw) - rolledZ * Math.sin(yaw), pitchedY, pitchedX * Math.sin(yaw) + rolledZ * Math.cos(yaw));
}

function glow(ctx, x, y, radius, stops) {
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
  for (const [at, color] of stops) gradient.addColorStop(at, color);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

// Cone desfocado do bocal para trás, que se apaga ao longo do comprimento.
function plume(ctx, ratio, from, to, r0, r1, color, alpha) {
  const axisX = to[0] - from[0], axisY = to[1] - from[1];
  const length = Math.hypot(axisX, axisY);
  if (length < 1 || alpha <= 0) return;
  const nx = -axisY / length, ny = axisX / length;
  const gradient = ctx.createLinearGradient(from[0], from[1], to[0], to[1]);
  gradient.addColorStop(0, `rgba(0,0,0,${alpha})`);
  gradient.addColorStop(0.45, `rgba(0,0,0,${alpha * 0.35})`);
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  blurred(ctx, ratio, Math.max(1.5, r0 * 0.7), rgba(color, 1), () => {
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(from[0] + nx * r0, from[1] + ny * r0);
    ctx.lineTo(to[0] + nx * r1, to[1] + ny * r1);
    ctx.lineTo(to[0] - nx * r1, to[1] - ny * r1);
    ctx.lineTo(from[0] - nx * r0, from[1] - ny * r0);
    ctx.closePath();
    ctx.fill();
  });
}

// [pass] é o avião agora, [elapsed] segundos depois de entrar em cena (nulo
// fora da travessia: o rastro ainda se desfaz depois que ele sai de cena).
function drawExhaust(ctx, ratio, width, height, flight, pass, elapsed) {
  const { exhaust, duration, model } = flight.aircraft;
  const [ex, ey, ez] = exhaust.at;
  const at = (q, aft, above = 0, lateral = 0) => bodyPoint(q, model.pivot, ex - aft, ey + above, ez + lateral);

  // 1. Rastro. Cada lufada nasce no bocal num instante fixo, recua com o
  // jato, abre, sobe um pouco e se apaga; o tamanho vem da distância em que
  // ela nasceu. Onde e como o avião estava ao soltar cada lufada não muda de
  // um quadro para o outro, então fica guardado no voo.
  const first = Math.max(0, Math.ceil((elapsed - EXHAUST_LIFE) / EXHAUST_STEP));
  const last = Math.min(Math.floor(elapsed / EXHAUST_STEP), Math.floor(duration / EXHAUST_STEP));
  const key = `${width}x${height}`;
  if (flight.birthKey !== key) {
    flight.birthKey = key;
    flight.births = new Map();
  }
  for (const k of flight.births.keys()) if (k < first) flight.births.delete(k);
  for (let k = first; k <= last; k += 1) {
    const born = k * EXHAUST_STEP;
    const age = elapsed - born;
    let q = flight.births.get(k);
    if (!q) {
      q = flightAt(width, height, flight, born);
      flight.births.set(k, q);
    }
    const n1 = noise(k, 1, 83), n2 = noise(k, 2, 89), n3 = noise(k, 3, 97);
    const drift = 6 * (1 - Math.exp(-age / 0.5));
    const p = at(q, drift, (n2 - 0.5) * 0.6 * age + 0.15 * age * age, (n1 - 0.5) * 0.6 * age);
    const radius = (exhaust.radius * (1.1 + 1.6 * age) + 0.25 * age) * (0.8 + 0.4 * n3) * q.ppm;
    const alpha = q.opacity * 0.2 * Math.min(age / 0.05, 1) * (1 - age / EXHAUST_LIFE) ** 1.6;
    const heat = Math.min(age / 0.35, 1);
    const color = EXHAUST_HOT.map((c, i) => Math.round(c + (EXHAUST_SMOKE[i] - c) * heat));
    glow(ctx, p[0], p[1], Math.max(radius, 0.5), [[0, rgba(color, alpha)], [1, rgba(color, 0)]]);
  }

  // 2. Jato quente e brilho do bocal, com uma leve cintilação.
  if (!pass) return;
  const t = elapsed * 18, i = Math.floor(t);
  const flicker = 0.85 + 0.15 * (noise(i, 9, 71) + (noise(i + 1, 9, 71) - noise(i, 9, 71)) * (t - i));
  const strength = pass.opacity * flicker;
  const r = exhaust.radius * pass.ppm;
  const exit = at(pass, 0);
  plume(ctx, ratio, exit, at(pass, 4.2 * flicker), r * 1.05, r * 1.7, [255, 132, 60], 0.45 * strength);
  plume(ctx, ratio, exit, at(pass, 1.8 * flicker), r * 0.6, r * 0.8, [255, 228, 186], 0.7 * strength);
  glow(ctx, exit[0], exit[1], r * 2.4, [
    [0, rgba([255, 236, 204], 0.6 * strength)],
    [0.4, rgba([255, 150, 70], 0.25 * strength)],
    [1, rgba([255, 120, 50], 0)]
  ]);
}

// ── Componente ────────────────────────────────────────────────────────────

export default function SubmarineScene({ playing, accent }) {
  const modelRef = useRef(null);
  const wakeRef = useRef(null);
  const playingRef = useRef(playing);
  const accentRef = useRef(parseAccent(accent));
  playingRef.current = playing;
  accentRef.current = parseAccent(accent);

  useEffect(() => {
    let disposed = false, frame = 0, renderer = null;
    let throttle = 0, lastTime = 0, lastKey = "";
    const scene = modelRef.current?.parentElement;
    // Onde cada um passa, medido no layout de verdade. O submarino vai fundo,
    // pelo meio do cartão de volume, com o casco entrando por trás do vidro
    // fosco dele; a aeronave, entre a capa e o topo da vela do submarino.
    // Com a tela deitada a coluna fica mais larga que alta, e os tamanhos, que
    // são frações da largura, estouravam: nela os dois acompanham a altura.
    const layoutOf = () => {
      const hero = scene.parentElement, box = hero?.getBoundingClientRect();
      if (!box?.height) return null;
      const aspect = box.width / box.height;
      const scale = Math.min(1, 0.7 / aspect);
      const at = (selector, edge) => {
        const node = hero.querySelector(selector);
        return node ? (node.getBoundingClientRect()[edge] - box.top) / box.height : null;
      };
      const volumeTop = at(".volume-control", "top"), volumeBottom = at(".volume-control", "bottom");
      const art = hero.querySelector(".cover-progress") ? ".cover-progress" : ".cover-wrap";
      const coverTop = at(art, "top"), coverBottom = at(art, "bottom");
      const artBox = hero.querySelector(art)?.getBoundingClientRect();
      const coverBox = artBox && {
        left: (artBox.left - box.left) / box.width,
        right: (artBox.right - box.left) / box.width,
        top: coverTop,
        bottom: coverBottom
      };
      const sub =volumeTop == null ? 0.62 : Math.max(0.45, Math.min(0.8, volumeTop + 0.6 * (volumeBottom - volumeTop)));
      const cover = coverBottom == null ? 0.2 : Math.max(0.08, Math.min(0.6, (coverTop + coverBottom) / 2));
      // Até onde a vela do submarino sobe acima da linha dele: cresce com o
      // tamanho do casco na tela, e os rumos que vêm de longe passam mais
      // altos. Calibrado simulando milhares de travessias.
      const sail = 0.03 + 0.14 * scale * aspect;
      return { sub, cover, box: coverBox, ceiling: 4 / box.height, floor: sub - sail - 0.02, aspect, scale };
    };
    const newCourse = () => { const l = layoutOf(); return l ? randomCourse(l.sub, l.scale) : randomCourse(0.62); };
    // Nenhuma aeronave repete a manobra da sua passagem anterior.
    const lastManeuver = new Map();
    const takeOff = (aircraft, avoid) => {
      const next = awayFrom(avoid, () => randomFlight(aircraft, layoutOf() || undefined, lastManeuver.get(aircraft)));
      lastManeuver.set(aircraft, next.maneuver.kind);
      return next;
    };
    // [turn] é a vez na SEQUENCE; [elapsed], há quanto tempo quem está na vez
    // entrou em cena; [route], o rumo dele (do submarino ou da aeronave).
    let turn = 0, elapsed = OPENING;
    let route = takeOff(SEQUENCE[0], null);
    route.notBefore = OPENING;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    const tick = now => {
      if (disposed) return;
      const dt = lastTime ? Math.min((now - lastTime) / 1000, 0.1) : 0;
      lastTime = now;
      if (reducedMotion.matches) {
        throttle = 0;
      } else {
        const before = easeInOut(throttle);
        throttle = Math.max(0, Math.min(1, throttle + (playingRef.current ? dt : -dt) / RAMP_SECONDS));
        const after = easeInOut(throttle);
        elapsed += dt * (before + after) / 2;
        // Quem estava na vez já saiu de cena e o mar descansou: passa a vez ao
        // próximo da sequência, com um rumo novo.
        while (elapsed >= SEQUENCE[turn].duration + PAUSE) {
          elapsed -= SEQUENCE[turn].duration + PAUSE;
          const left = side(route.exitX);
          turn = (turn + 1) % SEQUENCE.length;
          route = SEQUENCE[turn] === SUBMARINE ? newCourse() : takeOff(SEQUENCE[turn], left);
        }
      }

      const rect = scene.getBoundingClientRect();
      const width = rect.width, height = rect.height;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const accentColor = accentRef.current;
      const actor = SEQUENCE[turn];
      const loaded = renderer.has(actor.model);
      const key = `${turn}|${elapsed}|${width}|${height}|${ratio}|${accentColor}|${loaded}`;
      if (width && height && key !== lastKey) {
        lastKey = key;
        const pass = elapsed > actor.duration || !loaded
          ? null
          : actor === SUBMARINE ? passAt(width, height, route, elapsed / CROSSING) : flightAt(width, height, route, elapsed);
        renderer.draw([
          { model: actor.model, pass, angle: elapsed * actor.revs * 2 * Math.PI }
        ], width, height, ratio);
        drawBackdrop(wakeRef.current, width, height, ratio, ctx => {
          if (actor === SUBMARINE && pass) {
            drawShadow(ctx, ratio, pass);
            drawWake(ctx, ratio, width, pass, elapsed, accentColor);
          }
          if (actor.exhaust && loaded) drawExhaust(ctx, ratio, width, height, route, pass, elapsed);
        });
        modelRef.current.style.opacity = String(BACKDROP_OPACITY * (pass ? pass.opacity : 0));
      }
      frame = requestAnimationFrame(tick);
    };

    try {
      renderer = createRenderer(modelRef.current);
    } catch (error) {
      console.error("Não foi possível iniciar o cenário 3D:", error);
    }
    if (!renderer) return undefined;
    frame = requestAnimationFrame(tick);

    const load = (model, label) => fetch(model.url)
      .then(response => { if (!response.ok) throw new Error(`Modelo do ${label} indisponível`); return response.json(); })
      .then(data => { if (!disposed) renderer.add(model, data); })
      .catch(error => console.error(`Não foi possível desenhar o ${label}:`, error));
    // Os modelos chegam um de cada vez, na ordem em que entram em cena.
    SEQUENCE.reduce(
      (chain, item) => chain.then(() => (disposed ? undefined : load(item.model, item.label))),
      Promise.resolve()
    );

    return () => { disposed = true; cancelAnimationFrame(frame); renderer.dispose(); };
  }, []);

  // A esteira e a sombra ficam atrás do casco, como no app.
  return (
    <div className="hero-submarine" aria-hidden="true">
      <canvas ref={wakeRef} style={{ opacity: BACKDROP_OPACITY }} />
      <canvas ref={modelRef} />
    </div>
  );
}
