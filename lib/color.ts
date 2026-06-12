// Gamut-clamped OKLCH -> sRGB conversion (Björn Ottosson's matrices), used by the
// telemetry canvas so trace colors stay perceptually consistent with the CSS
// token palette. Canvas color parsing for oklch() is uneven across engines, so we
// resolve to plain sRGB here and never hand oklch() strings to the 2D context.

export type Rgb = [number, number, number];

export function oklchToRgb(L: number, C: number, h: number): Rgb {
  const hr = (h * Math.PI) / 180;
  const a = C * Math.cos(hr);
  const b = C * Math.sin(hr);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;

  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];

  return lin.map((v) => {
    v = Math.min(1, Math.max(0, v));
    const enc = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.round(enc * 255);
  }) as Rgb;
}

export const rgb = ([r, g, b]: Rgb, alpha = 1): string =>
  alpha >= 1 ? `rgb(${r} ${g} ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
