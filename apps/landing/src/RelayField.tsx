import { useEffect, useRef, useState } from 'react';

import { COINS, COIN_LABELS } from './content.ts';

/** Field width at which the composition is drawn at full size. */
const BASE_WIDTH = 1024;
/** Centre of the Relay mark, px from the top of the field. */
const CENTRE_Y = 402;
/** Coins within this many px of the cursor (at full size) are pushed away. */
const CURSOR_RADIUS = 190;
/** Furthest a coin is pushed, px at full size. Small: the coins make way, they do not scatter. */
const MAX_PUSH = 20;
/** A flick faster than this (px per event) nudges the coins it passes through. */
const FLICK_SPEED = 28;
const FLICK_RADIUS = 80;
const FLICK_FORCE = 0.05;
/** The mark's image, at full size. The letter itself is about 187px wide. */
const MARK_W = 308;
const MARK_H = 205;
const ORBITS_W = 1100;
const ORBITS_H = 480;

/** Smaller screens get a smaller composition, so it never crowds the text. */
const scaleFor = (width: number) => Math.min(1.12, Math.max(0.7, width / BASE_WIDTH));

interface Body {
  x: number; y: number; vx: number; vy: number; rot: number;
  mass: number; spring: number; damp: number;
  f1: number; f2: number; p1: number; p2: number; a1: number; a2: number;
}

/** Each coin its own mass, spring and damping, so they never move in step. */
function bodies(): Body[] {
  return COINS.map((c, i) => ({
    x: 0, y: 0, vx: 0, vy: 0, rot: 0,
    mass: 0.6 + c.size / 260,
    spring: 0.01 + 0.004 * Math.max(0, 3 - c.depth),
    damp: 0.9 - 0.012 * c.depth,
    f1: 0.12 + i * 0.017, f2: 0.09 + i * 0.013, p1: i * 1.7, p2: i * 2.3,
    a1: 5 + c.depth * 2.4, a2: 4 + c.depth * 2.1,
  }));
}

/** Where a sparkle sits on an ellipse, for the few bright points along the orbits. */
const onEllipse = (cx: number, cy: number, rx: number, ry: number, t: number) => [cx + rx * Math.cos(t), cy + ry * Math.sin(t)] as const;

/**
 * The hero's coin field: the Relay mark inside two orbits, USDT and TRX coins
 * around it at different depths. The cursor pushes coins aside and they spring
 * back; the mark and orbits lean with it; scrolling eases the whole field away.
 * Click a coin to label it.
 *
 * Everything moves through refs and one animation loop; React renders the
 * field once and again only when the selection changes.
 */
export function RelayField() {
  const field = useRef<HTMLDivElement>(null);
  const mark = useRef<HTMLDivElement>(null);
  const orbits = useRef<SVGSVGElement>(null);
  const tag = useRef<HTMLDivElement>(null);
  const coins = useRef<(HTMLDivElement | null)[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const selectedRef = useRef<number | null>(null);
  selectedRef.current = selected;

  useEffect(() => {
    const el = field.current;
    if (!el) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const sim = bodies();
    const pointer = { x: -9999, y: -9999, inside: false };
    let visible = true;
    let raf = 0;
    // Sized before the first frame, so the composition never flashes at full size.
    let scale = scaleFor(el.getBoundingClientRect().width);
    el.style.setProperty('--s', scale.toFixed(4));

    const home = (i: number, width: number) => {
      const c = COINS[i]!;
      return { x: width / 2 + c.dx * scale, y: CENTRE_Y + c.dy * scale };
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const inside = x >= 0 && y >= 0 && x <= r.width && y <= r.height;
      // A quick flick through a coin knocks it along, not just away.
      if (inside && pointer.inside && !still) {
        const vx = x - pointer.x;
        const vy = y - pointer.y;
        if (Math.hypot(vx, vy) > FLICK_SPEED) {
          sim.forEach((s, i) => {
            const h = home(i, r.width);
            const d = Math.hypot(x - (h.x + s.x), y - (h.y + s.y));
            if (d < FLICK_RADIUS * scale) {
              const k = (1 - d / (FLICK_RADIUS * scale)) * FLICK_FORCE / s.mass;
              s.vx += vx * k;
              s.vy += vy * k;
            }
          });
        }
      }
      pointer.x = x;
      pointer.y = y;
      pointer.inside = inside;
    };
    const onLeave = () => { pointer.inside = false; };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (!visible) return;
      const t = now / 1000;
      const r = el.getBoundingClientRect();
      const nextScale = scaleFor(r.width);
      if (nextScale !== scale) {
        scale = nextScale;
        el.style.setProperty('--s', scale.toFixed(4));
      }
      const cx = r.width / 2;
      // Scroll progress through the hero, not raw scrollY: the field eases
      // away as it leaves, whatever sits above it.
      const prog = still ? 0 : Math.max(0, Math.min(1, -(r.top + 40) / 700));
      const px = pointer.inside ? pointer.x / r.width - 0.5 : 0;
      const py = pointer.inside ? pointer.y / r.height - 0.5 : 0;
      const sel = selectedRef.current;
      const radius = CURSOR_RADIUS * scale;

      sim.forEach((s, i) => {
        const c = COINS[i]!;
        const node = coins.current[i];
        if (!node) return;
        const h = home(i, r.width);
        const lean = [0, 1, 2, 4, 6][c.depth]!;
        let tx = still ? 0 : (Math.sin(t * s.f1 + s.p1) * s.a1 + px * lean) * scale + Math.sign(c.dx) * prog * 90 * scale;
        let ty = still ? 0 : (Math.cos(t * s.f2 + s.p2) * s.a2 + py * lean * 0.7) * scale + Math.sign(c.dy) * prog * 70 * scale;
        if (pointer.inside && !still) {
          const dx = pointer.x - (h.x + s.x);
          const dy = pointer.y - (h.y + s.y);
          const d = Math.hypot(dx, dy);
          if (d < radius && d > 0.1) {
            const n = 1 - d / radius;
            const ramp = d < 50 * scale ? 0.92 : n * n * 1.25;
            const push = MAX_PUSH * Math.min(1, ramp) * scale / s.mass;
            // Away from the cursor: the target moves opposite to it.
            tx -= dx / d * push;
            ty -= dy / d * push;
          }
        }
        s.vx = (s.vx + (tx - s.x) * s.spring / s.mass) * s.damp;
        s.vy = (s.vy + (ty - s.y) * s.spring / s.mass) * s.damp;
        s.x += s.vx;
        s.y += s.vy;
        s.rot += s.vx * 0.02;

        const half = c.size * scale / 2;
        const isSel = sel === c.id;
        const grow = (isSel ? 1.14 : 1) * (1 - prog * 0.22);
        const opacity = sel !== null && !isSel ? 0.34 : 1 - prog * 0.85;
        node.style.transform = `translate3d(${(h.x + s.x - half).toFixed(2)}px, ${(h.y + s.y - half).toFixed(2)}px, 0) rotate(${(s.rot * 0.3).toFixed(2)}deg) scale(${grow.toFixed(3)})`;
        node.style.opacity = opacity.toFixed(3);
      });

      if (mark.current) {
        const w = MARK_W * scale;
        const hgt = MARK_H * scale;
        mark.current.style.transform = `translate(${(cx - w / 2 + px * 6).toFixed(1)}px, ${(CENTRE_Y - hgt / 2 + py * 4).toFixed(1)}px) scale(${(1 + prog * 0.12).toFixed(3)})`;
        mark.current.style.opacity = (1 - prog * 0.7).toFixed(3);
      }
      if (orbits.current) {
        orbits.current.style.transform = `translate(${(cx - ORBITS_W * scale / 2 + px * 4).toFixed(1)}px, ${(CENTRE_Y - ORBITS_H * scale / 2 + py * 3).toFixed(1)}px)`;
        orbits.current.style.opacity = (1 - prog).toFixed(2);
      }
      if (tag.current) {
        if (sel !== null) {
          const c = COINS[sel]!;
          const s = sim[sel]!;
          const h = home(sel, r.width);
          tag.current.style.opacity = '1';
          tag.current.style.transform = `translate(${(h.x + s.x + c.size * scale * 0.6).toFixed(0)}px, ${(h.y + s.y - 18).toFixed(0)}px)`;
        } else {
          tag.current.style.opacity = '0';
        }
      }
    };

    // Nothing to animate while the hero is off screen.
    const observer = new IntersectionObserver(([entry]) => { visible = entry?.isIntersecting ?? true; });
    observer.observe(el);
    window.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('pointerleave', onLeave);
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerleave', onLeave);
    };
  }, []);

  const label = selected === null ? null : COIN_LABELS[COINS[selected]!.asset];
  const sparkles = [
    onEllipse(-16, 0, 460, 181, 0.35), onEllipse(-16, 0, 460, 181, 2.2), onEllipse(-16, 0, 460, 181, 3.55),
    onEllipse(48, 6, 326, 131, 4.4), onEllipse(48, 6, 326, 131, 1.2), onEllipse(0, 4, 540, 214, 5.3),
  ];

  return (
    <div className="field" ref={field} aria-hidden="true" onClick={() => setSelected(null)}>
      <svg
        className="orbits"
        ref={orbits}
        viewBox={`${-ORBITS_W / 2} ${-ORBITS_H / 2} ${ORBITS_W} ${ORBITS_H}`}
        style={{ width: `calc(${ORBITS_W}px * var(--s, 1))`, height: `calc(${ORBITS_H}px * var(--s, 1))` }}
      >
        <g transform="rotate(-4)" fill="none">
          <ellipse cx={0} cy={4} rx={540} ry={214} stroke="rgba(255,255,255,0.045)" />
          <ellipse cx={-16} cy={0} rx={460} ry={181} stroke="rgba(255,255,255,0.14)" />
          <ellipse cx={48} cy={6} rx={326} ry={131} stroke="rgba(255,255,255,0.1)" />
          {sparkles.map(([x, y], i) => <circle key={i} cx={x} cy={y} r={1.6} fill="rgba(255,255,255,0.55)" stroke="none" />)}
        </g>
      </svg>

      <div className="mark-wrap" ref={mark} style={{ width: `calc(${MARK_W}px * var(--s, 1))`, height: `calc(${MARK_H}px * var(--s, 1))` }}>
        <div className="bloom" />
        <img src="/assets/relay-mark-hero.webp" alt="" width={720} height={480} fetchPriority="high" />
      </div>

      {COINS.map((c) => {
        const usdt = c.asset === 'USDT';
        return (
          <div
            key={c.id}
            className="coin"
            ref={(node) => { coins.current[c.id] = node; }}
            onClick={(e) => { e.stopPropagation(); setSelected((s) => (s === c.id ? null : c.id)); }}
            style={{
              width: `calc(${c.size}px * var(--s, 1))`,
              height: `calc(${c.size}px * var(--s, 1))`,
              zIndex: c.depth + (c.depth >= 3 ? 1 : 0),
              filter: c.blur ? `blur(calc(${c.blur}px * var(--s, 1)))` : undefined,
            }}
          >
            <div className="glow" style={{ background: `radial-gradient(closest-side, ${usdt ? 'rgba(72,206,168,' : 'rgba(232,104,94,'}${c.glow}), rgba(0,0,0,0) 72%)` }} />
            <img src={`/assets/coin-${c.sprite}.webp`} alt="" draggable={false} />
          </div>
        );
      })}

      <div className="coin-tag" ref={tag}>
        {label && (
          <>
            <div className="name">{label.name}</div>
            <div className="lines">{label.lines.map((l) => <div key={l}>{l}</div>)}</div>
          </>
        )}
      </div>
    </div>
  );
}
