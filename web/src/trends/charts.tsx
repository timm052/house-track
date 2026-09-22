// Small SVG charts for the Trends page, following the data-viz method: one axis, thin marks, a legend
// for 2+ series with sparing direct labels, recessive hairline grid, and a hover tooltip on every chart.
// Colours come from the validated palette slots (--series-1 blue, --series-2 orange) in styles.css.
import { useRef, useState, type ReactNode } from "react";

export const W = 640, H = 240;
const PAD = { l: 56, r: 64, t: 12, b: 28 };

export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / count, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  // Round outwards so the first and last ticks enclose every value: marks never leave the plot.
  const out = [];
  const end = Math.ceil(max / step) * step;
  for (let v = Math.floor(min / step) * step; v <= end + 1e-9; v += step) out.push(Math.round(v));
  return out;
}

type Tip = { x: number; y: number; body: ReactNode } | null;

function Frame({ children, tip, label, onLeave, onMove }: {
  children: ReactNode; tip: Tip; label: string; onLeave?: () => void; onMove?: (e: React.PointerEvent<SVGSVGElement>) => void;
}) {
  return (
    <div className="viz-frame">
      <svg viewBox={`0 0 ${W} ${H}`} className="viz" role="img" aria-label={label} onPointerLeave={onLeave} onPointerMove={onMove}>
        {children}
      </svg>
      {tip && (
        <div className="viz-tip" style={{ left: `${(tip.x / W) * 100}%`, top: `${(tip.y / H) * 100}%` }}>{tip.body}</div>
      )}
    </div>
  );
}

function YAxis({ ticks, y, fmt }: { ticks: number[]; y: (v: number) => number; fmt: (v: number) => string }) {
  return (
    <g>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} className="viz-grid" />
          <text x={PAD.l - 6} y={y(t) + 4} textAnchor="end" className="viz-tick">{fmt(t)}</text>
        </g>
      ))}
    </g>
  );
}

export type Series = { key: string; label: string; slot: 1 | 2; points: { x: string; v: number | null }[] };

/** Monthly lines on one money axis, with a crosshair that lists every series at the hovered month. */
export function LineChart({ series, fmt, label }: { series: Series[]; fmt: (v: number) => string; label: string }) {
  const xs = series[0]?.points.map((p) => p.x) ?? [];
  const values = series.flatMap((s) => s.points.map((p) => p.v)).filter((v): v is number => v != null);
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  if (xs.length < 2 || !values.length) return <p className="small muted">Not enough months of data for a trend yet.</p>;
  const ticks = niceTicks(Math.min(...values), Math.max(...values));
  const [lo, hi] = [ticks[0], ticks[ticks.length - 1]];
  const x = (i: number) => PAD.l + (i / (xs.length - 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => H - PAD.b - ((v - lo) / (hi - lo || 1)) * (H - PAD.t - PAD.b);
  const path = (s: Series) => s.points.map((p, i) => (p.v == null ? null : `${x(i)},${y(p.v)}`)).filter(Boolean)
    .map((pt, i) => `${i ? "L" : "M"}${pt}`).join(" ");
  const tip: Tip = hover == null ? null : {
    x: x(hover), y: PAD.t,
    body: <>{xs[hover]}{series.map((s) => (
      <div key={s.key}><span className={`viz-key slot-${s.slot}`} /> <strong>{s.points[hover].v == null ? "—" : fmt(s.points[hover].v!)}</strong> {s.label}</div>
    ))}</>,
  };
  return (
    <>
      <div className="viz-legend">{series.map((s) => <span key={s.key}><span className={`viz-key slot-${s.slot}`} /> {s.label}</span>)}</div>
      <Frame label={label} tip={tip} onLeave={() => setHover(null)}
        onMove={(e) => {
          const box = (svgRef.current ?? (e.currentTarget as SVGSVGElement)).getBoundingClientRect();
          const px = ((e.clientX - box.left) / box.width) * W;
          setHover(Math.max(0, Math.min(xs.length - 1, Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * (xs.length - 1)))));
        }}>
        <YAxis ticks={ticks} y={y} fmt={fmt} />
        {xs.map((m, i) => (i % Math.ceil(xs.length / 8) === 0 || i === xs.length - 1) && (
          <text key={m} x={x(i)} y={H - 8} textAnchor="middle" className="viz-tick">{m}</text>
        ))}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} className="viz-crosshair" />}
        {series.map((s) => {
          const last = [...s.points.keys()].reverse().find((i) => s.points[i].v != null);
          return (
            <g key={s.key}>
              <path d={path(s)} className={`viz-line slot-${s.slot}`} />
              {s.points.map((p, i) => p.v != null && (
                <circle key={i} cx={x(i)} cy={y(p.v)} r={hover === i || i === last ? 4 : 0} className={`viz-dot slot-${s.slot}`} />
              ))}
              {last != null && <text x={x(last) + 8} y={y(s.points[last].v!) + 4} className="viz-label">{fmt(s.points[last].v!)}</text>}
            </g>
          );
        })}
      </Frame>
    </>
  );
}

export type Dot = { id: string; x: number; y: number; label: string };

/** One series of dots on two money axes, with a y = x line for reference. */
export function Scatter({ dots, fmt, xLabel, yLabel, label }: { dots: Dot[]; fmt: (v: number) => string; xLabel: string; yLabel: string; label: string }) {
  const [hover, setHover] = useState<Dot | null>(null);
  if (dots.length < 2) return <p className="small muted">Needs at least two houses with both figures.</p>;
  const all = dots.flatMap((d) => [d.x, d.y]);
  const ticks = niceTicks(Math.min(...all), Math.max(...all));
  const [lo, hi] = [ticks[0], ticks[ticks.length - 1]];
  const sx = (v: number) => PAD.l + ((v - lo) / (hi - lo || 1)) * (W - PAD.l - PAD.r);
  const sy = (v: number) => H - PAD.b - ((v - lo) / (hi - lo || 1)) * (H - PAD.t - PAD.b);
  const tip: Tip = hover && { x: sx(hover.x), y: sy(hover.y), body: <>
    <div><strong>{fmt(hover.y)}</strong> {yLabel}</div><div><strong>{fmt(hover.x)}</strong> {xLabel}</div><div className="muted">{hover.label}</div></> };
  return (
    <Frame label={label} tip={tip} onLeave={() => setHover(null)}>
      <YAxis ticks={ticks} y={sy} fmt={fmt} />
      {ticks.map((t) => <text key={t} x={sx(t)} y={H - 8} textAnchor="middle" className="viz-tick">{fmt(t)}</text>)}
      <line x1={sx(lo)} y1={sy(lo)} x2={sx(hi)} y2={sy(hi)} className="viz-ref" />
      <text x={sx(hi) - 4} y={sy(hi) + 14} textAnchor="end" className="viz-tick">sold = guide top</text>
      {dots.map((d) => (
        <g key={d.id} onPointerEnter={() => setHover(d)}>
          <circle cx={sx(d.x)} cy={sy(d.y)} r={12} className="viz-hit" />
          <circle cx={sx(d.x)} cy={sy(d.y)} r={5} className="viz-dot ringed slot-1" />
        </g>
      ))}
    </Frame>
  );
}

/** Count of houses per price band. */
export function Histogram({ values, step, fmt, label }: { values: number[]; step: number; fmt: (v: number) => string; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  if (values.length < 2) return <p className="small muted">Not enough prices yet.</p>;
  const start = Math.floor(Math.min(...values) / step) * step;
  const n = Math.floor((Math.max(...values) - start) / step) + 1;
  const bins = Array.from({ length: n }, (_, i) => ({ from: start + i * step, count: 0 }));
  values.forEach((v) => bins[Math.floor((v - start) / step)].count++);
  const maxC = Math.max(...bins.map((b) => b.count));
  const ticks = niceTicks(0, maxC, Math.min(4, maxC));
  const top = ticks[ticks.length - 1] || 1;
  const band = (W - PAD.l - PAD.r) / n, bw = Math.min(24, band - 2);
  const y = (c: number) => H - PAD.b - (c / top) * (H - PAD.t - PAD.b);
  const tip: Tip = hover == null ? null : { x: PAD.l + band * (hover + 0.5), y: y(bins[hover].count),
    body: <><strong>{bins[hover].count}</strong> {bins[hover].count === 1 ? "house" : "houses"}<div className="muted">{fmt(bins[hover].from)}–{fmt(bins[hover].from + step)}</div></> };
  return (
    <Frame label={label} tip={tip} onLeave={() => setHover(null)}>
      <YAxis ticks={ticks} y={y} fmt={(v) => String(v)} />
      {bins.map((b, i) => {
        const cx = PAD.l + band * (i + 0.5), top_ = y(b.count);
        return (
          <g key={b.from} onPointerEnter={() => setHover(i)}>
            <rect x={PAD.l + band * i} y={PAD.t} width={band} height={H - PAD.t - PAD.b} className="viz-hit" />
            {b.count > 0 && <path className="viz-bar slot-1" d={`M${cx - bw / 2},${H - PAD.b} V${top_ + 4} q0,-4 4,-4 H${cx + bw / 2 - 4} q4,0 4,4 V${H - PAD.b} Z`} />}
            {(i % Math.ceil(n / 7) === 0) && <text x={PAD.l + band * i} y={H - 8} className="viz-tick">{fmt(b.from)}</text>}
          </g>
        );
      })}
    </Frame>
  );
}
