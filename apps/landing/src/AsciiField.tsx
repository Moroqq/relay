import { useEffect, useRef } from 'react';

/**
 * A field of monospace characters behind the header and hero.
 *
 * Slow clouds of faint glyphs drift across the page, drawn from fractal noise.
 * Around the cursor the characters come up in USDT teal and some of them turn
 * into hash digits that re-roll a few times a second, like transaction ids
 * scrolling past. Faster movement widens the lit area.
 *
 * One fragment shader does all of it: each screen cell picks its glyph from a
 * small atlas drawn at start-up in IBM Plex Mono. Nothing is drawn on touch
 * screens, where there is no cursor to follow, nor while the hero is off screen
 * or the tab is hidden. Without WebGL2 the page simply has no field.
 */

const RAMP = ' .·:-=+*#%';
const HEX = '0123456789abcdef';
const CELL_W = 10;
const CELL_H = 16;
const FONT_PX = 12;

const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform vec2 uRes;       // canvas, device px
uniform vec2 uCell;      // one character cell, device px
uniform float uTime;
uniform vec2 uPointer;   // device px, origin top-left
uniform float uPresence; // 0..1, eases in and out as the cursor enters and leaves
uniform float uEnergy;   // 0..1, how fast the cursor is moving
uniform sampler2D uAtlas;
uniform vec4 uQuiet[2];  // text blocks (x0, y0, x1, y1 device px): the field steps back behind them
out vec4 outColor;

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
  return v;
}

void main() {
  vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 cell = floor(frag / uCell);
  vec2 center = (cell + 0.5) * uCell;
  vec2 local = (frag - cell * uCell) / uCell;

  // Clouds about a dozen rows across, drifting, leaning a little toward the cursor.
  float scale = 1.0 / (uCell.y * 12.0);
  float t = uTime * 0.035;
  vec2 lean = (uPointer - center) * scale * 0.07 * uPresence;
  float n = fbm(center * scale + vec2(t, -t * 0.6) + lean);
  float cloud = smoothstep(0.54, 0.88, n);

  float radius = uCell.y * (8.5 + uEnergy * 4.0);
  float d = length(center - uPointer);
  float near = exp(-(d * d) / (radius * radius)) * uPresence;

  float lum = max(cloud * 0.72, near * (0.5 + 0.5 * n));
  if (lum < 0.03) { outColor = vec4(0.0); return; }

  // Density ramp in row 0 of the atlas; hash digits in row 1.
  float glyph = floor(clamp(lum, 0.0, 0.999) * 10.0);
  float row = 0.0;
  float tick = floor(uTime * (3.0 + uEnergy * 9.0));
  if (near > 0.22 && hash21(cell + tick * vec2(1.7, 9.2)) < near * 0.75) {
    row = 1.0;
    glyph = floor(hash21(cell * 1.31 + tick) * 16.0);
  }
  float coverage = texture(uAtlas, (vec2(glyph, row) + local) / vec2(16.0, 2.0)).a;

  vec3 grey = vec3(0.541, 0.565, 0.600);
  vec3 teal = vec3(0.36, 0.87, 0.71);
  vec3 col = mix(grey, teal, smoothstep(0.06, 0.55, near));
  float alpha = coverage * (0.09 + 0.07 * cloud + 0.62 * near);
  // Behind the headline and figures the characters dim, so the words stay clean.
  for (int i = 0; i < 2; i++) {
    vec4 r = uQuiet[i];
    vec2 out2 = max(r.xy - center, center - r.zw);
    float inside = 1.0 - smoothstep(-uCell.y, uCell.y * 1.5, max(out2.x, out2.y));
    alpha *= mix(1.0, 0.32, inside);
  }
  // Fade out toward the bottom of the hero, so the field has no hard edge.
  alpha *= smoothstep(1.0, 0.8, frag.y / uRes.y);
  outColor = vec4(col * alpha, alpha);
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn('[ascii-field]', gl.getShaderInfoLog(shader));
    return null;
  }
  return shader;
}

/** Two rows of 16 cells: the density ramp, then hex digits. White on transparent. */
function drawAtlas(cellW: number, cellH: number, fontPx: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = cellW * 16;
  canvas.height = cellH * 2;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.font = `400 ${fontPx}px "IBM Plex Mono", ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  [...RAMP].forEach((ch, i) => ctx.fillText(ch, (i + 0.5) * cellW, cellH * 0.5));
  [...HEX].forEach((ch, i) => ctx.fillText(ch, (i + 0.5) * cellW, cellH * 1.5));
  return canvas;
}

export function AsciiField() {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const layer = host.current;
    if (!layer || window.matchMedia('(hover: none)').matches) return;
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: 'low-power' });
    if (!gl) return;

    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl.createProgram();
    if (!vs || !fs || !program) return;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn('[ascii-field]', gl.getProgramInfoLog(program));
      return;
    }
    gl.useProgram(program);
    layer.appendChild(canvas);

    const u = (name: string) => gl.getUniformLocation(program, name);
    const uRes = u('uRes'), uCell = u('uCell'), uTime = u('uTime'), uPointer = u('uPointer');
    const uPresence = u('uPresence'), uEnergy = u('uEnergy'), uQuiet = u('uQuiet');
    gl.uniform1i(u('uAtlas'), 0);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let dpr = 0;
    let cellW = CELL_W;
    let cellH = CELL_H;
    let fontReady = false;
    let disposed = false;
    let visible = true;
    let dirty = true;
    const pointer = { x: -1e5, y: -1e5, tx: -1e5, ty: -1e5, inside: false, presence: 0, energy: 0, lastX: 0, lastY: 0 };

    const buildAtlas = () => {
      const atlas = drawAtlas(cellW, cellH, Math.round(FONT_PX * dpr));
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
    };

    const resize = () => {
      const rect = layer.getBoundingClientRect();
      // Capped: past 1.5x the glyphs are already crisp and the GPU does double the work.
      const nextDpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.max(1, Math.round(rect.width * nextDpr));
      canvas.height = Math.max(1, Math.round(rect.height * nextDpr));
      gl.viewport(0, 0, canvas.width, canvas.height);
      if (nextDpr !== dpr) {
        dpr = nextDpr;
        // Whole device pixels per cell, so glyphs land on the pixel grid and stay sharp.
        cellW = Math.round(CELL_W * dpr);
        cellH = Math.round(CELL_H * dpr);
        if (fontReady) buildAtlas();
      }
      dirty = true;
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      const rect = canvas.getBoundingClientRect();
      pointer.tx = (e.clientX - rect.left) * dpr;
      pointer.ty = (e.clientY - rect.top) * dpr;
      pointer.inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
      if (pointer.x < -1e4) { pointer.x = pointer.tx; pointer.y = pointer.ty; }
    };
    const onLeave = () => { pointer.inside = false; };

    // The text blocks to keep clear, relative to the canvas. Only layout moves
    // them, so reading two rectangles a frame is cheap.
    const quiet = ['.intro', '.stats'].map((sel) => layer.parentElement?.querySelector(sel) ?? null);
    const quietRects = () => {
      const base = canvas.getBoundingClientRect();
      const out = new Float32Array(8).fill(-1e6);
      quiet.forEach((el, i) => {
        if (!el) return;
        const r = el.getBoundingClientRect();
        out.set([(r.left - base.left) * dpr, (r.top - base.top) * dpr, (r.right - base.left) * dpr, (r.bottom - base.top) * dpr], i * 4);
      });
      return out;
    };

    const start = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (!visible || !fontReady || document.hidden) return;

      pointer.x += (pointer.tx - pointer.x) * 0.2;
      pointer.y += (pointer.ty - pointer.y) * 0.2;
      pointer.presence += ((pointer.inside ? 1 : 0) - pointer.presence) * 0.06;
      const speed = Math.hypot(pointer.x - pointer.lastX, pointer.y - pointer.lastY) / dpr;
      pointer.lastX = pointer.x;
      pointer.lastY = pointer.y;
      pointer.energy += (Math.min(1, speed / 40) - pointer.energy) * 0.08;

      // With reduced motion the clouds hold still; only the cursor light moves.
      const settling = Math.abs(pointer.tx - pointer.x) > 0.5 || Math.abs(pointer.ty - pointer.y) > 0.5
        || Math.abs((pointer.inside ? 1 : 0) - pointer.presence) > 0.005;
      if (still && !settling && !dirty) return;
      dirty = false;

      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform4fv(uQuiet, quietRects());
      gl.uniform2f(uCell, cellW, cellH);
      gl.uniform1f(uTime, still ? 40 : (now - start) / 1000 + 40);
      gl.uniform2f(uPointer, pointer.x, pointer.y);
      gl.uniform1f(uPresence, pointer.presence);
      gl.uniform1f(uEnergy, still ? 0 : pointer.energy);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const sizeObserver = new ResizeObserver(resize);
    sizeObserver.observe(layer);
    const viewObserver = new IntersectionObserver(([entry]) => { visible = entry?.isIntersecting ?? true; });
    viewObserver.observe(layer);
    window.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('webglcontextlost', () => { cancelAnimationFrame(raf); canvas.remove(); });
    resize();

    // The atlas needs the real font; drawing it with a fallback would bake in the wrong shapes.
    void document.fonts.load(`400 ${FONT_PX}px "IBM Plex Mono"`).catch(() => undefined).then(() => {
      if (disposed) return;
      fontReady = true;
      buildAtlas();
      dirty = true;
    });
    raf = requestAnimationFrame(frame);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      sizeObserver.disconnect();
      viewObserver.disconnect();
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerleave', onLeave);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      canvas.remove();
    };
  }, []);

  return <div className="ascii-layer" ref={host} aria-hidden="true" />;
}
