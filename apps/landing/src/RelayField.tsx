import { useEffect, useRef, useState } from 'react';

import { COINS, COIN_LABELS } from './content.ts';

/** Coins within this many px of the cursor are pushed away. */
const CURSOR_RADIUS = 300;

interface Body {
  x: number; y: number; vx: number; vy: number; rot: number;
  mass: number; spring: number; damp: number;
  f1: number; f2: number; p1: number; p2: number; a1: number; a2: number;
}

/** Each coin its own mass, spring and damping, so they never move in step. */
function bodies(): Body[] {
  return COINS.map((c, i) => ({
    x: 0, y: 0, vx: 0, vy: 0, rot: (i % 2 ? 1 : -1) * (4 + i * 1.7),
    mass: 0.6 + c.size / 260,
    spring: 0.01 + 0.004 * (3 - c.depth),
    damp: 0.9 - 0.012 * c.depth,
    f1: 0.12 + i * 0.017, f2: 0.09 + i * 0.013, p1: i * 1.7, p2: i * 2.3,
    a1: 5 + c.depth * 2.4, a2: 4 + c.depth * 2.1,
  }));
}

/**
 * The hero's coin field: USDT and TRX coins drifting over the Relay mark,
 * pushed aside by the cursor and springing back. Click a coin to label it.
 *
 * Everything moves through refs and one animation loop; React renders the
 * field once and again only when the selection changes.
 */
export function RelayField() {
  const field = useRef<HTMLDivElement>(null);
  const bg = useRef<HTMLImageElement>(null);
  const rings = useRef<HTMLDivElement>(null);
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
        if (Math.hypot(vx, vy) > 14) {
          sim.forEach((s, i) => {
            const c = COINS[i]!;
            const d = Math.hypot(x - (c.x / 100 * r.width + s.x), y - (c.y / 100 * r.height + s.y));
            if (d < 130) {
              const k = (1 - d / 130) * 0.16 / s.mass;
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
      // Scroll progress through the hero, not raw scrollY: the field eases
      // away as it leaves, whatever sits above it.
      const prog = still ? 0 : Math.max(0, Math.min(1, -(r.top + 40) / 700));
      const px = pointer.inside ? pointer.x / r.width - 0.5 : 0;
      const py = pointer.inside ? pointer.y / r.height - 0.5 : 0;
      const sel = selectedRef.current;

      sim.forEach((s, i) => {
        const c = COINS[i]!;
        const node = coins.current[i];
        if (!node) return;
        const bx = c.x / 100 * r.width;
        const by = c.y / 100 * r.height;
        const lean = c.depth === 3 ? 10 : c.depth === 2 ? 5 : 2;
        let tx = still ? 0 : Math.sin(t * s.f1 + s.p1) * s.a1 + px * lean + (c.x - 50) / 50 * prog * 90;
        let ty = still ? 0 : Math.cos(t * s.f2 + s.p2) * s.a2 + py * lean * 0.7 + prog * (c.y > 50 ? 70 : -70);
        if (pointer.inside && !still) {
          const dx = pointer.x - (bx + s.x);
          const dy = pointer.y - (by + s.y);
          const d = Math.hypot(dx, dy);
          if (d < CURSOR_RADIUS && d > 0.1) {
            const n = 1 - d / CURSOR_RADIUS;
            const ramp = d < 70 ? 0.92 : n * n * 1.25;
            const push = Math.min(48, 48 * Math.min(1, ramp)) / s.mass;
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

        const isSel = sel === c.id;
        const scale = (isSel ? 1.14 : 1) * (1 - prog * 0.22);
        const opacity = sel !== null && !isSel ? 0.34 : 1 - prog * 0.85;
        node.style.transform = `translate3d(calc(-50% + ${s.x.toFixed(2)}px), calc(-50% + ${s.y.toFixed(2)}px), 0) rotate(${(s.rot * 0.3).toFixed(2)}deg) scale(${scale.toFixed(3)})`;
        node.style.opacity = opacity.toFixed(3);
      });

      if (rings.current) {
        rings.current.style.transform = `translate(${(px * 4).toFixed(1)}px, ${(py * 3).toFixed(1)}px)`;
        rings.current.style.opacity = (1 - prog).toFixed(2);
      }
      if (bg.current) {
        bg.current.style.transform = `translate(calc(-50% + ${(px * 5).toFixed(1)}px), calc(-50% + ${(py * 4).toFixed(1)}px)) scale(${(1 + prog * 0.16).toFixed(3)})`;
        bg.current.style.opacity = (0.85 * (1 - prog * 0.6)).toFixed(3);
      }
      if (tag.current) {
        if (sel !== null) {
          const c = COINS[sel]!;
          const s = sim[sel]!;
          tag.current.style.opacity = '1';
          tag.current.style.transform = `translate(${(c.x / 100 * r.width + s.x + c.size * 0.6).toFixed(0)}px, ${(c.y / 100 * r.height + s.y - 18).toFixed(0)}px)`;
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

  return (
    <div className="field" ref={field} aria-hidden="true" onClick={() => setSelected(null)}>
      <div className="art">
        <img className="bg" ref={bg} src="/assets/hero-bg.webp" alt="" width={1672} height={941} fetchPriority="high" />
        <div className="rings" ref={rings}>
          <div className="ring" style={{ width: 640, height: 640 }} />
          <div className="ring" style={{ width: 830, height: 830, borderColor: 'rgba(255,255,255,0.04)' }} />
          <div className="ring" style={{ width: 1040, height: 1040, borderColor: 'rgba(255,255,255,0.028)' }} />
        </div>
      </div>
      {COINS.map((c) => {
        const usdt = c.asset === 'USDT';
        return (
          <div
            key={c.id}
            className="coin"
            ref={(node) => { coins.current[c.id] = node; }}
            onClick={(e) => { e.stopPropagation(); setSelected((s) => (s === c.id ? null : c.id)); }}
            style={{ left: `${c.x}%`, top: `${c.y}%`, width: c.size, height: c.size, zIndex: c.depth, filter: `blur(${c.blur}px)`, transform: 'translate3d(-50%, -50%, 0)' }}
          >
            <div className="glow" style={{ background: `radial-gradient(closest-side, ${usdt ? 'rgba(72,206,168,' : 'rgba(232,104,94,'}${c.glow}), rgba(0,0,0,0) 72%)` }} />
            <img src={`/assets/coin-${c.sprite}.webp`} alt="" draggable={false} style={{ transform: `rotate(${c.rot}deg) scaleX(${c.sx})` }} />
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
