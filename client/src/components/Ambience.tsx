import { useEffect, useMemo } from 'react';

/** Small deterministic PRNG so the decoration is stable between renders. */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export type Mood = 'calm' | 'turn';

/**
 * Full-screen atmosphere: slow light rays, breathing colour glows, floating
 * lanterns, golden dust and a spotlight that follows the pointer.
 * Purely decorative (pointer-events: none) and disabled by prefers-reduced-motion.
 */
export function Ambience({ mood = 'calm' }: { mood?: Mood }) {
  const lanterns = useMemo(() => {
    const r = seeded(7);
    return Array.from({ length: 7 }, (_, i) => ({
      left: 6 + i * 14 + r() * 6,
      size: 16 + r() * 16,
      delay: -r() * 30,
      dur: 26 + r() * 22,
      hue: r() < 0.5 ? 'saffron' : 'rose',
    }));
  }, []);
  const sparks = useMemo(() => {
    const r = seeded(21);
    return Array.from({ length: 30 }, () => ({
      left: r() * 100,
      size: 2 + r() * 3.5,
      delay: -r() * 18,
      dur: 9 + r() * 14,
      drift: (r() - 0.5) * 120,
    }));
  }, []);

  useEffect(() => {
    let raf = 0;
    const root = document.documentElement;
    const move = (e: PointerEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        root.style.setProperty('--mx', `${e.clientX}px`);
        root.style.setProperty('--my', `${e.clientY}px`);
      });
    };
    window.addEventListener('pointermove', move, { passive: true });
    return () => { window.removeEventListener('pointermove', move); cancelAnimationFrame(raf); };
  }, []);

  return (
    <div className={`ambience ambience--${mood}`} aria-hidden>
      <div className="ambience__glow ambience__glow--a" />
      <div className="ambience__glow ambience__glow--b" />
      <div className="ambience__glow ambience__glow--c" />
      <div className="ambience__rays" />
      <div className="ambience__spot" />
      {lanterns.map((l, i) => (
        <span
          key={i}
          className={`lantern lantern--${l.hue}`}
          style={{ left: `${l.left}%`, width: l.size, height: l.size * 1.35, animationDelay: `${l.delay}s`, animationDuration: `${l.dur}s` }}
        />
      ))}
      {sparks.map((s, i) => (
        <i
          key={i}
          className="spark"
          style={{ left: `${s.left}%`, width: s.size, height: s.size, animationDelay: `${s.delay}s`, animationDuration: `${s.dur}s`, ['--drift' as string]: `${s.drift}px` }}
        />
      ))}
      <div className="ambience__turn" />
      <div className="ambience__vignette" />
    </div>
  );
}
