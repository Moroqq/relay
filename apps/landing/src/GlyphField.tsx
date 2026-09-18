import { useEffect, useRef } from 'react';

/**
 * A grid of faint dots behind the sections below the hero. Around the cursor
 * the dots become characters, densest at the centre and thinning outward in
 * rings — the character in a cell depends only on its distance from the
 * cursor, so nothing flickers or changes at random.
 *
 * The canvas is fixed to the viewport and drawn by one fragment shader; the
 * grid itself is pinned to the page, so it scrolls with the content. The hero
 * sits above it on an opaque background, which is what keeps the first screen
 * clear. Nothing is drawn on touch screens, where there is no cursor, while
 * the lower sections are off screen, or without WebGL2.
 */

/** From the edge of the lit area in to its centre. */
const RAMP = ['.', 'I', '+', 'o', 'O', '?', '#', '\\'];
const CELL_W = 12;
const CELL_H = 15;
const FONT_PX = 12;
/** Radius of the lit area, px. */
const RADIUS = 170;
/** Most text blocks the field steps back from at once. */
const MAX_QUIET = 40;

const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform vec2 uRes;       // canvas, device px
uniform vec2 uCell;      // one character cell, device px
uniform float uScroll;   // page scroll, device px: keeps the grid pinned to the page
uniform vec2 uPointer;   // device px, viewport, origin top-left
uniform float uPresence; // 0..1, eases in and out as the cursor enters and leaves
uniform float uRadius;   // device px
uniform float uTop;      // device px: nothing above this line (the hero's bottom edge)
uniform sampler2D uAtlas;
uniform vec4 uQuiet[${MAX_QUIET}];
uniform int uQuietCount;
out vec4 outColor;

void main() {
  vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  if (frag.y < uTop) { outColor = vec4(0.0); return; }
  vec2 page = vec2(frag.x, frag.y + uScroll);
  vec2 cell = floor(page / uCell);
  vec2 local = (page - cell * uCell) / uCell;
  vec2 center = (cell + 0.5) * uCell - vec2(0.0, uScroll);

  // Distance as a share of the lit radius; the area grows in as the cursor arrives.
  float r = length(center - uPointer) / max(uRadius * uPresence, 1.0);
  // Even rings, one character each: 7 at the core (about a quarter of the
  // radius), down to 1 at the rim; 0 is the resting dot.
  float level = clamp(ceil((0.95 - r) / 0.1), 0.0, 7.0);
  float coverage = texture(uAtlas, vec2((level + local.x) / 8.0, local.y)).a;

  float k = level / 7.0;
  vec3 dim = vec3(0.16, 0.34, 0.20);
  vec3 lit = vec3(0.27, 0.88, 0.43);
  vec3 col = mix(dim, lit, k);
  float alpha = coverage * mix(0.3, 1.0, k);

  // Words stay clean: behind a heading or a figure the characters step back.
  if (level > 0.0) {
    for (int i = 0; i < ${MAX_QUIET}; i++) {
      if (i >= uQuietCount) break;
      vec4 q = uQuiet[i];
      vec2 out2 = max(q.xy - center, center - q.zw);
      float inside = 1.0 - smoothstep(-uCell.y * 0.5, uCell.y, max(out2.x, out2.y));
      alpha *= mix(1.0, 0.28, inside);
    }
  }
  outColor = vec4(col * alpha, alpha);
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn('[glyph-field]', gl.getShaderInfoLog(shader));
    return null;
  }
  return shader;
}

/** One row of eight cells, white on transparent. */
function drawAtlas(cellW: number, cellH: number, fontPx: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = cellW * RAMP.length;
  canvas.height = cellH;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.font = `500 ${fontPx}px "IBM Plex Mono", ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  RAMP.forEach((ch, i) => ctx.fillText(ch, (i + 0.5) * cellW, cellH * 0.55));
  return canvas;
}

/** The text blocks in the lower sections the field dims behind. */
const QUIET_SELECTOR = [
  'main .eyebrow', 'main .h2', 'main .lead', '.flow-node', '.infra-node', '.asset',
  '.cta .btn', '.cta .mark', '.footer .lockup', '.footer .ok',
].join(', ');

export function GlyphField({ below }: { below: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const layer = host.current;
    const hero = document.querySelector<HTMLElement>(below);
    if (!layer || !hero || window.matchMedia('(hover: none)').matches) return;
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
      console.warn('[glyph-field]', gl.getProgramInfoLog(program));
      return;
    }
    gl.useProgram(program);
    layer.appendChild(canvas);

    const u = (name: string) => gl.getUniformLocation(program, name);
    const uRes = u('uRes'), uCell = u('uCell'), uScroll = u('uScroll'), uPointer = u('uPointer');
    const uPresence = u('uPresence'), uRadius = u('uRadius'), uTop = u('uTop');
    const uQuiet = u('uQuiet'), uQuietCount = u('uQuietCount');
    gl.uniform1i(u('uAtlas'), 0);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    let dpr = 0;
    let cellW = CELL_W;
    let cellH = CELL_H;
    let fontReady = false;
    let disposed = false;
    let dirty = true;
    const pointer = { x: -1e5, y: -1e5, tx: -1e5, ty: -1e5, inside: false, presence: 0 };
    const quiet = new Float32Array(MAX_QUIET * 4);

    const buildAtlas = () => {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, drawAtlas(cellW, cellH, Math.round(FONT_PX * dpr)));
    };

    const resize = () => {
      // Capped: past 1.5x the glyphs are already crisp and the GPU does double the work.
      const nextDpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.max(1, Math.round(window.innerWidth * nextDpr));
      canvas.height = Math.max(1, Math.round(window.innerHeight * nextDpr));
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

    const heroBottom = () => hero.getBoundingClientRect().bottom;

    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      pointer.tx = e.clientX * dpr;
      pointer.ty = e.clientY * dpr;
      pointer.inside = e.clientY > heroBottom();
      if (pointer.x < -1e4) { pointer.x = pointer.tx; pointer.y = pointer.ty; }
      dirty = true;
    };
    const onLeave = () => { pointer.inside = false; dirty = true; };
    const onScroll = () => { dirty = true; };

    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const top = heroBottom();
      // The hero fills the screen: nothing of the field would show.
      if (!fontReady || top >= window.innerHeight) return;
      const settling = Math.abs(pointer.tx - pointer.x) > 0.5 || Math.abs(pointer.ty - pointer.y) > 0.5
        || Math.abs((pointer.inside ? 1 : 0) - pointer.presence) > 0.005;
      if (!dirty && !settling) return;
      dirty = false;
      pointer.x += (pointer.tx - pointer.x) * 0.25;
      pointer.y += (pointer.ty - pointer.y) * 0.25;
      pointer.presence += ((pointer.inside ? 1 : 0) - pointer.presence) * 0.12;

      let count = 0;
      if (pointer.presence > 0.01) {
        for (const el of document.querySelectorAll(QUIET_SELECTOR)) {
          if (count >= MAX_QUIET) break;
          const r = el.getBoundingClientRect();
          if (r.bottom < 0 || r.top > window.innerHeight) continue;
          quiet.set([r.left * dpr, r.top * dpr, r.right * dpr, r.bottom * dpr], count * 4);
          count++;
        }
      }

      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform2f(uCell, cellW, cellH);
      gl.uniform1f(uScroll, window.scrollY * dpr);
      gl.uniform2f(uPointer, pointer.x, pointer.y);
      gl.uniform1f(uPresence, pointer.presence);
      gl.uniform1f(uRadius, RADIUS * dpr);
      gl.uniform1f(uTop, Math.max(0, top) * dpr);
      gl.uniform4fv(uQuiet, quiet);
      gl.uniform1i(uQuietCount, count);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    window.addEventListener('resize', resize);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('webglcontextlost', () => { cancelAnimationFrame(raf); canvas.remove(); });
    resize();

    // The atlas needs the real font; drawing it with a fallback would bake in the wrong shapes.
    void document.fonts.load(`500 ${FONT_PX}px "IBM Plex Mono"`).catch(() => undefined).then(() => {
      if (disposed) return;
      fontReady = true;
      buildAtlas();
      dirty = true;
    });
    raf = requestAnimationFrame(frame);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerleave', onLeave);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      canvas.remove();
    };
  }, [below]);

  return <div className="glyph-layer" ref={host} aria-hidden="true" />;
}
