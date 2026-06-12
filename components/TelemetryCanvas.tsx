'use client';

import { useEffect, useRef } from 'react';
import { useTheme } from '@/components/ThemeProvider';
import { useStatus } from '@/components/StatusProvider';
import { useTraffic } from '@/components/TrafficProvider';
import { oklchToRgb, rgb, type Rgb } from '@/lib/color';
import type { HealthLevel } from '@/lib/status';
import styles from './TelemetryCanvas.module.css';

interface Palette {
  primary: Rgb;
  soft: Rgb;
  third: Rgb;
  grid: Rgb;
  glow: number;
  fillAlpha: number;
}

const PALETTES: Record<'light' | 'dark', Palette> = {
  light: {
    primary: oklchToRgb(0.6, 0.13, 200),
    soft: oklchToRgb(0.64, 0.12, 285),
    third: oklchToRgb(0.6, 0.13, 230),
    grid: oklchToRgb(0.5, 0.02, 230),
    glow: 0,
    fillAlpha: 0.1,
  },
  dark: {
    primary: oklchToRgb(0.74, 0.13, 200),
    soft: oklchToRgb(0.72, 0.12, 285),
    third: oklchToRgb(0.74, 0.13, 230),
    grid: oklchToRgb(0.7, 0.02, 240),
    glow: 9,
    fillAlpha: 0.16,
  },
};

// Status nudges the scene through MOTION only — calmer when healthy, more
// turbulent and higher-amplitude when not. Colors stay tied to the subdomains
// (the traffic legend maps each wire to a host), so we never recolor a wire to
// signal an outage; that would break the legend and read as one host being
// special. The outage itself is stated plainly in the status pulse text.
const STATUS: Record<HealthLevel, { amp: number; turb: number }> = {
  operational: { amp: 1, turb: 1 },
  partial: { amp: 1.18, turb: 1.5 },
  degraded: { amp: 1.42, turb: 2.2 },
};

// Each trace is a sum of incommensurate sines so it reads as data, not a pure
// sine. [amplitude(frac of band), spatial frequency, phase, drift speed]
type Comp = [number, number, number, number];
interface Trace {
  comps: Comp[];
  baseAmp: number;
  width: number;
}

// The three traces double as the three subdomain "wires": MAIN, SECONDARY, GHOST.
const MAIN: Trace = {
  baseAmp: 0.34,
  width: 1.9,
  comps: [
    [0.6, 1.3, 0.0, 0.18],
    [0.26, 3.1, 1.7, -0.32],
    [0.14, 6.7, 4.2, 0.52],
  ],
};
const SECONDARY: Trace = {
  baseAmp: 0.2,
  width: 1.4,
  comps: [
    [0.5, 2.1, 2.4, -0.22],
    [0.3, 4.3, 0.6, 0.4],
    [0.2, 8.9, 3.1, -0.6],
  ],
};
const GHOST: Trace = {
  baseAmp: 0.46,
  width: 1.1,
  comps: [
    [0.7, 0.9, 5.0, 0.1],
    [0.3, 2.4, 1.2, -0.16],
  ],
};
const TRACES = [MAIN, SECONDARY, GHOST];
// Per-lane time scale. The ghost wire drifts slower; its packets must use the same
// factor or they'd float off the curve they're meant to ride.
const LANE_TIME = [1, 1, 0.7];

// Packets per second when there's no real per-subdomain data: a calm ambient drift
// so the wires still feel alive (decoration, not a data claim). Real rates scale up.
const AMBIENT_PPS = [0.5, 0.34, 0.22];
const MAX_PACKETS = 26;

interface Packet {
  lane: number;
  p: number; // position along the wire, 0..1
  speed: number; // fraction of width per second
  size: number;
}

// `t` is the accumulated phase clock (see driftRef) — turbulence scales how fast
// that clock ADVANCES, never the phase directly: multiplying a large absolute
// time by a changing rate would jump the phase by many radians at once and
// visibly scramble the waveform every time the status level flips.
function sampleTrace(trace: Trace, xNorm: number, t: number): number {
  let v = 0;
  for (const [a, f, phase, speed] of trace.comps) {
    v += a * Math.sin(xNorm * f * Math.PI * 2 + phase + t * speed);
  }
  return v * trace.baseAmp;
}

const lerp = (a: number, b: number, m: number) => a + (b - a) * m;
const lerpRgb = (a: Rgb, b: Rgb, m: number): Rgb => [
  Math.round(lerp(a[0], b[0], m)),
  Math.round(lerp(a[1], b[1], m)),
  Math.round(lerp(a[2], b[2], m)),
];
function lerpPalette(a: Palette, b: Palette, m: number): Palette {
  return {
    primary: lerpRgb(a.primary, b.primary, m),
    soft: lerpRgb(a.soft, b.soft, m),
    third: lerpRgb(a.third, b.third, m),
    grid: lerpRgb(a.grid, b.grid, m),
    glow: lerp(a.glow, b.glow, m),
    fillAlpha: lerp(a.fillAlpha, b.fillAlpha, m),
  };
}
// ease-out-quart, matches the CSS token used for the page crossfade.
const easeOutQuart = (x: number) => 1 - Math.pow(1 - x, 4);

export function TelemetryCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { theme } = useTheme();
  const { status } = useStatus();
  const { traffic } = useTraffic();
  const level = status.level;

  // Persist the intro across theme/status changes so it only plays on first mount.
  const introStartRef = useRef<number | null>(null);
  const introDoneRef = useRef(false);
  // Status feeds the loop through a ref so a level change NEVER restarts the
  // animation (a flapping backend would hitch the scene every poll); the loop
  // eases amp/turb toward the current target instead of jumping.
  const levelRef = useRef<HealthLevel>(level);
  // Wave phase clock, advanced per frame at a turbulence-scaled rate. A ref so
  // a theme change (which restarts the loop for the palette crossfade) doesn't
  // reset the waves' phase mid-scene.
  const driftRef = useRef(12.4);
  // Remember the theme the running loop started in, so a change can crossfade.
  const prevThemeRef = useRef<'light' | 'dark'>(theme);
  // Per-lane packet emission rate (packets/sec), and the live packets in flight.
  const subRatesRef = useRef<number[]>([...AMBIENT_PPS]);
  const packetsRef = useRef<Packet[]>([]);
  const emitAccRef = useRef<number[]>([0, 0, 0]);

  useEffect(() => {
    levelRef.current = level;
  }, [level]);

  // Map each subdomain's recent request rate onto its wire's packet emission rate.
  useEffect(() => {
    const subs = traffic?.subdomains ?? [];
    subRatesRef.current = [0, 1, 2].map((i) => {
      const r = subs[i]?.rate;
      if (r == null) return AMBIENT_PPS[i]; // ambient drift where there's no data
      return Math.min(3.6, Math.max(0.12, r / 18)); // req/min → packets/sec, clamped
    });
  }, [traffic]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Mutable copy: the loop eases it toward STATUS[levelRef.current] each frame.
    const tuning = { ...STATUS[levelRef.current] };
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Crossfade the palette when the theme changed since the last loop start.
    const fromTheme = prevThemeRef.current;
    prevThemeRef.current = theme;
    const crossfade = fromTheme !== theme && !reduceMotion;
    const fromPalette = PALETTES[fromTheme];
    const toPalette = PALETTES[theme];
    let paletteStart = 0;
    let palette: Palette = toPalette; // reassigned each frame during a crossfade
    let lastNow = 0;

    let width = 0;
    let height = 0;
    let dpr = 1;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    const laneColor = (lane: number): Rgb =>
      lane === 0 ? palette.primary : lane === 1 ? palette.soft : palette.third;

    const drawTrace = (
      trace: Trace,
      t: number,
      amp: number,
      color: Rgb,
      lineAlpha: number,
      withFill: boolean,
      withGlow: boolean,
    ) => {
      const midY = height * 0.56;
      const band = height * amp;
      const step = Math.max(4, Math.round(width / 240));

      ctx.beginPath();
      let firstY = midY;
      for (let px = 0; px <= width; px += step) {
        const xn = px / width;
        const y = midY - sampleTrace(trace, xn, t) * band;
        if (px === 0) {
          firstY = y;
          ctx.moveTo(px, y);
        } else {
          ctx.lineTo(px, y);
        }
      }

      if (withFill) {
        const grad = ctx.createLinearGradient(0, midY - band, 0, height);
        grad.addColorStop(0, rgb(color, palette.fillAlpha));
        grad.addColorStop(1, rgb(color, 0));
        ctx.save();
        ctx.lineTo(width, height);
        ctx.lineTo(0, height);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.restore();

        ctx.beginPath();
        ctx.moveTo(0, firstY);
        for (let px = step; px <= width; px += step) {
          const xn = px / width;
          const y = midY - sampleTrace(trace, xn, t) * band;
          ctx.lineTo(px, y);
        }
      }

      ctx.lineWidth = trace.width;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = rgb(color, lineAlpha);
      if (withGlow && palette.glow > 0) {
        ctx.shadowColor = rgb(color, 0.8);
        ctx.shadowBlur = palette.glow;
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    };

    const drawGrid = () => {
      ctx.lineWidth = 1;
      ctx.strokeStyle = rgb(palette.grid, theme === 'dark' ? 0.08 : 0.1);
      const rows = 5;
      for (let i = 1; i < rows; i++) {
        const y = Math.round((height * i) / rows) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
    };

    // Advance + emit packets. dt is clamped so a backgrounded tab can't burst.
    const stepPackets = (dt: number) => {
      const rates = subRatesRef.current;
      const acc = emitAccRef.current;
      const pkts = packetsRef.current;
      for (let lane = 0; lane < 3; lane++) {
        acc[lane] += (rates[lane] || 0) * dt;
        while (acc[lane] >= 1 && pkts.length < MAX_PACKETS) {
          acc[lane] -= 1;
          pkts.push({ lane, p: 0, speed: 0.16 + Math.random() * 0.1, size: 1.7 + Math.random() });
        }
        if (acc[lane] > 3) acc[lane] = 3;
      }
      for (let i = pkts.length - 1; i >= 0; i--) {
        pkts[i].p += pkts[i].speed * dt;
        if (pkts[i].p > 1.05) pkts.splice(i, 1);
      }
    };

    // Draw each packet as a glowing head with a short streak trailing along its wire.
    const drawPackets = (t: number, amp: number) => {
      const midY = height * 0.56;
      const band = height * amp;
      const yAt = (lane: number, xn: number) =>
        midY - sampleTrace(TRACES[lane], xn, t * LANE_TIME[lane]) * band;

      for (const pk of packetsRef.current) {
        const col = laneColor(pk.lane);
        const fade = Math.max(0, Math.min(1, pk.p / 0.06, (1 - pk.p) / 0.06));
        if (fade <= 0) continue;

        // Trailing streak (no glow, cheap) — the wire "lighting up" behind the head.
        const segs = 4;
        for (let s = segs; s >= 1; s--) {
          const a = pk.p - s * 0.014;
          const b = pk.p - (s - 1) * 0.014;
          if (a < 0) continue;
          ctx.beginPath();
          ctx.moveTo(a * width, yAt(pk.lane, a));
          ctx.lineTo(b * width, yAt(pk.lane, b));
          ctx.lineWidth = 1.6;
          ctx.lineCap = 'round';
          ctx.strokeStyle = rgb(col, fade * 0.16 * (1 - (s - 1) / segs));
          ctx.stroke();
        }

        // Glowing head.
        ctx.save();
        ctx.fillStyle = rgb(col, fade);
        ctx.shadowColor = rgb(col, 0.9);
        ctx.shadowBlur = palette.glow > 0 ? 10 : 5;
        ctx.beginPath();
        ctx.arc(pk.p * width, yAt(pk.lane, pk.p), pk.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    };

    const render = (t: number, introScale: number) => {
      ctx.clearRect(0, 0, width, height);
      drawGrid();
      const amp = tuning.amp * introScale;
      // Ghost (lane 3 / depth), secondary (lane 2), then main (lane 1) on top.
      drawTrace(GHOST, t * LANE_TIME[2], amp, palette.third, 0.18, false, false);
      drawTrace(SECONDARY, t, amp, palette.soft, 0.42, false, false);
      drawTrace(MAIN, t, amp, palette.primary, 0.92, true, true);
      drawPackets(t, amp);
    };

    let raf = 0;
    const loop = (now: number) => {
      const dt = lastNow === 0 ? 0 : Math.min(0.05, (now - lastNow) / 1000);
      lastNow = now;

      if (crossfade) {
        if (paletteStart === 0) paletteStart = now;
        const m = (now - paletteStart) / 450;
        palette = m >= 1 ? toPalette : lerpPalette(fromPalette, toPalette, easeOutQuart(m));
      }

      // Ease toward the current status targets (~0.5s) instead of jumping.
      const target = STATUS[levelRef.current];
      const k = Math.min(1, dt * 2);
      tuning.amp += (target.amp - tuning.amp) * k;
      tuning.turb += (target.turb - tuning.turb) * k;

      let introScale = 1;
      if (!introDoneRef.current) {
        if (introStartRef.current == null) introStartRef.current = now;
        const elapsed = (now - introStartRef.current) / 900;
        if (elapsed >= 1) {
          introScale = 1;
          introDoneRef.current = true;
        } else {
          introScale = elapsed <= 0 ? 0 : 1 - Math.pow(2, -10 * elapsed); // ease-out-expo
        }
      }

      stepPackets(dt);
      // Advance the phase clock; turbulence speeds the ADVANCE, never the phase.
      driftRef.current += dt * (1 + (tuning.turb - 1) * 0.4);
      render(driftRef.current, introScale);
      raf = requestAnimationFrame(loop);
    };

    if (reduceMotion) {
      introDoneRef.current = true;
      palette = toPalette;
      // A still, composed frame with a few packets parked on each wire.
      packetsRef.current = [];
      for (let lane = 0; lane < 3; lane++) {
        for (const p of [0.3, 0.66]) packetsRef.current.push({ lane, p, speed: 0, size: 2 });
      }
      render(driftRef.current, 1);
    } else {
      raf = requestAnimationFrame(loop);
    }

    const onResize = () => resize();
    window.addEventListener('resize', onResize);

    const onVisibility = () => {
      if (reduceMotion) return;
      if (document.visibilityState === 'hidden') {
        cancelAnimationFrame(raf);
      } else {
        lastNow = 0; // avoid a dt jump after being hidden
        raf = requestAnimationFrame(loop);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [theme]);

  return (
    <div className={styles.wrap} aria-hidden="true">
      <canvas ref={canvasRef} className={styles.canvas} />
    </div>
  );
}
