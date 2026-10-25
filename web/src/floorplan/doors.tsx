// Doors and windows for the floor plan's Door tool. A door is placed in a wall (it sits on the wall's centre line, turns
// with it, takes the wall's thickness and cuts its opening) or on its own over the plan. Each kind is drawn the way a
// plan draws it: a hinged door with its leaf open 90° and its swing; double doors; sliding, cavity and barn doors;
// bifolds; a panel-lift garage door with the space it swings up into; a plain opening; a window. Sizes are common
// Australian ones (a standard internal door is 820 mm).
import type { ReactNode } from "react";

export type DoorKind = "single" | "double" | "sliding" | "cavity" | "barn" | "bifold" | "garage" | "opening" | "window";
export const DOOR_KINDS: { kind: DoorKind; label: string; widths: number[]; width: number }[] = [
  { kind: "single", label: "Hinged door", widths: [0.62, 0.72, 0.77, 0.82, 0.87, 0.92, 1.02], width: 0.82 },
  { kind: "double", label: "Double doors", widths: [1.2, 1.44, 1.64, 1.84], width: 1.44 },
  { kind: "sliding", label: "Sliding door", widths: [1.5, 1.8, 2.1, 2.4, 3.0], width: 2.1 },
  { kind: "cavity", label: "Cavity slider", widths: [0.72, 0.82, 0.92], width: 0.82 },
  { kind: "barn", label: "Barn door", widths: [0.82, 0.92, 1.2, 1.5], width: 0.92 },
  { kind: "bifold", label: "Bifold doors", widths: [1.8, 2.4, 3.0, 3.6, 4.8], width: 2.4 },
  { kind: "garage", label: "Garage door", widths: [2.4, 2.7, 3.0, 4.8, 5.4], width: 2.4 },
  { kind: "opening", label: "Opening (no door)", widths: [0.82, 0.9, 1.2, 1.8, 2.4], width: 0.9 },
  { kind: "window", label: "Window", widths: [0.6, 0.9, 1.2, 1.5, 1.8, 2.4], width: 1.2 },
];
export const DOOR_BY_KIND = new Map(DOOR_KINDS.map((d) => [d.kind, d]));
/** Kinds whose drawing has a hinge side and a swing side worth flipping. */
export const HANDED = new Set<DoorKind>(["single", "double", "cavity", "barn", "bifold", "garage"]);
export const SWINGS = new Set<DoorKind>(["single", "double", "barn", "bifold", "garage"]);
/** How thick a door standing on its own is drawn (its frame), when there's no wall to take it from. */
export const FREE_DEPTH = 0.11;

export type Door = {
  id: string; type: "door"; kind: DoorKind; x: number; y: number; w: number; rotation: number;
  hinge: "left" | "right"; side: 1 | -1; host?: string;
};
type Pt = [number, number];
type Wall = { id: string; type: "line"; points: Pt[]; thickness?: number; closed?: boolean };

/** Where a door at p would sit in a wall, if one is close enough: on its centre line, turned with it, kept clear of
 *  the wall's ends. `reach` is how far off (plan pixels) still counts, beyond the wall's own half thickness. */
export function hostFor(p: Pt, w: number, walls: Wall[], ppm: number, reach: number, prefer?: string):
    { id: string; p: Pt; deg: number; depth: number } | null {
  let best: { id: string; p: Pt; deg: number; depth: number; d: number } | null = null;
  for (const wall of walls) {
    const pts = wall.closed ? [...wall.points, wall.points[0]] : wall.points, t = (wall.thickness ?? 0) * ppm;
    for (let i = 1; i < pts.length; i++) {
      const [a, b] = [pts[i - 1], pts[i]], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1) continue;
      const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
      const half = Math.min((w * ppm) / 2, len / 2);
      const along = Math.max(half, Math.min(len - half, (p[0] - a[0]) * ux + (p[1] - a[1]) * uy));
      const q: Pt = [a[0] + ux * along, a[1] + uy * along];
      let d = Math.hypot(p[0] - q[0], p[1] - q[1]) - t / 2;
      if (wall.id === prefer) d -= reach / 2;   // stay in the wall it's in, given a near tie
      if (d < reach && (!best || d < best.d)) best = { id: wall.id, p: q, deg: (Math.atan2(uy, ux) * 180) / Math.PI, depth: Math.max(t, 2), d };
    }
  }
  return best && { id: best.id, p: best.p, deg: best.deg, depth: best.depth };
}

/** Where a door is drawn: in its wall (followed if the wall has moved), else where it was put. */
export function placed(d: Door, walls: Wall[], ppm: number): { x: number; y: number; deg: number; depth: number; hosted: boolean } {
  const host = d.host ? walls.find((w) => w.id === d.host) : undefined;
  const h = host && hostFor([d.x, d.y], d.w, [host], ppm, Infinity);
  if (h) return { x: h.p[0], y: h.p[1], deg: h.deg, depth: h.depth, hosted: true };
  return { x: d.x, y: d.y, deg: d.rotation, depth: FREE_DEPTH * ppm, hosted: false };
}

// ─── drawing ───────────────────────────────────────────────────────────
const INK = "#2b2f31", LEAF = "#ffffff", GLASS = "#bcd3e0";

/** A door drawn centred on the origin across the x axis: W wide, T deep (the wall), swinging toward +y on the left
 *  hinge; the caller mirrors it for the other hand and side. `m` turns metres into plan pixels. */
export function DoorSymbol({ kind, W, T, m, hinge, side, k }: { kind: DoorKind; W: number; T: number; m: (n: number) => number;
                                                                hinge: "left" | "right"; side: 1 | -1; k: number }) {
  const out: ReactNode[] = [];
  const sw = (n: number) => n / k;   // screen pixels to plan units: lines stay crisp at any zoom
  const L = (x1: number, y1: number, x2: number, y2: number, w = 1.2, dash?: string, stroke = INK) =>
    out.push(<line key={out.length} x1={x1} y1={y1} x2={x2} y2={y2} stroke={stroke} strokeWidth={sw(w)} strokeDasharray={dash} />);
  const R = (x: number, y: number, w: number, h: number, fill = LEAF, lw = 1.2, dash?: string) =>
    out.push(<rect key={out.length} x={Math.min(x, x + w)} y={Math.min(y, y + h)} width={Math.abs(w)} height={Math.abs(h)} fill={fill}
      stroke={INK} strokeWidth={sw(lw)} strokeDasharray={dash} />);
  const P = (d: string, w = 0.9, dash = `${sw(5)} ${sw(3)}`, fill = "none") =>
    out.push(<path key={out.length} d={d} fill={fill} stroke={INK} strokeWidth={sw(w)} strokeDasharray={dash} />);
  const x0 = -W / 2, x1 = W / 2, t = T / 2, leaf = Math.max(m(0.035), sw(2.5));
  const arrow = (xa: number, xb: number, y: number) => {
    L(xa, y, xb, y, 0.9);
    const dir = Math.sign(xb - xa), a = Math.min(m(0.08), Math.abs(xb - xa) * 0.3);
    out.push(<polygon key={out.length} points={`${xb},${y} ${xb - dir * a},${y - a * 0.5} ${xb - dir * a},${y + a * 0.5}`} fill={INK} />);
  };
  const jambs = () => { L(x0, -t, x0, t, 1.6); L(x1, -t, x1, t, 1.6); };

  switch (kind) {
    case "single":
      jambs();
      R(x0, t, leaf, W);                                   // the leaf, open 90°
      P(`M${x0} ${t + W} A${W} ${W} 0 0 0 ${x1} ${t}`);   // its swing
      L(x0, 0, x1, 0, 0.6, `${sw(2)} ${sw(3)}`);
      break;
    case "double": {
      const half = W / 2;
      jambs();
      R(x0, t, leaf, half); R(x1 - leaf, t, leaf, half);
      P(`M${x0} ${t + half} A${half} ${half} 0 0 0 0 ${t}`);
      P(`M${x1} ${t + half} A${half} ${half} 0 0 1 0 ${t}`);
      break;
    }
    case "sliding": {
      jambs();
      const p = Math.max(T * 0.22, sw(3)), o = W * 0.04;
      R(x0, -t * 0.55, W / 2 + o, p, GLASS);   // the fixed panel
      R(-o, t * 0.55 - p, W / 2 + o, p, GLASS); // the sliding one
      arrow(W * 0.32, W * 0.08, t + m(0.12));
      break;
    }
    case "cavity":
      jambs();
      R(x0 - W, -t * 0.5, W, T * 0.5, "none", 0.8, `${sw(4)} ${sw(3)}`);   // the pocket inside the wall
      R(x0 - W * 0.75, -leaf / 2, W, leaf);                                  // the door, most of the way into it
      arrow(x0 + W * 0.2, x0 + W * 0.55, t + m(0.12));
      break;
    case "barn": {
      jambs();
      const face = t + m(0.03);
      L(x0 - W * 1.05, face, x1 + m(0.05), face, 0.8, `${sw(5)} ${sw(3)}`);   // the track on the wall's face
      R(x0 - W * 0.95, face, W * 1.1, leaf * 1.2);                            // the door, slid open
      arrow(x0 + W * 0.15, x0 + W * 0.6, face + m(0.16));
      break;
    }
    case "bifold": {
      jambs();
      const n = W > 2.0 * m(1) ? 4 : 2, each = W / n, h = each * 0.6;   // half open: the leaves at an angle
      const pts = Array.from({ length: n + 1 }, (_, i) => `${x0 + i * each},${i % 2 ? t + h : t}`).join(" ");
      out.push(<polyline key={out.length} points={pts} fill="none" stroke={INK} strokeWidth={sw(2.2)} strokeLinejoin="round" />);
      L(x0, t, x1, t, 0.6, `${sw(2)} ${sw(3)}`);
      break;
    }
    case "garage": {
      jambs();
      R(x0, -leaf / 2, W, leaf, "#d9dde0");
      const up = Math.min(m(2.4), W * 1.1);   // a panel-lift door runs up into the garage about its own height
      R(x0 + m(0.05), t, W - m(0.1), up, "none", 0.8, `${sw(6)} ${sw(4)}`);
      break;
    }
    case "opening":
      jambs();
      L(x0, 0, x1, 0, 0.6, `${sw(2)} ${sw(4)}`);
      break;
    case "window":
      R(x0, -t, W, T, LEAF, 1.4);
      L(x0, -T * 0.1, x1, -T * 0.1, 0.8, undefined, "#5b8aa3");
      L(x0, T * 0.1, x1, T * 0.1, 0.8, undefined, "#5b8aa3");
      L(x0 - m(0.03), t + m(0.04), x1 + m(0.03), t + m(0.04), 1.2);   // the sill
      break;
  }
  return <g transform={`scale(${hinge === "right" ? -1 : 1} ${side})`}>{out}</g>;
}

/** The kind drawn small for the door options, fitted to a box. */
export function DoorPreview({ kind, size = 34 }: { kind: DoorKind; size?: number }) {
  const W = size * 0.62, T = size * 0.14, ppm = W / (DOOR_BY_KIND.get(kind)!.width);
  return (
    <svg width={size} height={size} viewBox={`${-size / 2} ${-size * 0.3} ${size} ${size}`} aria-hidden className="fp-door-preview">
      <rect x={-size / 2} y={-T / 2} width={(size - W) / 2} height={T} fill="#c9cdd0" />
      <rect x={W / 2} y={-T / 2} width={(size - W) / 2} height={T} fill="#c9cdd0" />
      <DoorSymbol kind={kind} W={W} T={T} m={(n) => n * ppm * (kind === "garage" ? 0.5 : 1)} hinge="left" side={1} k={1.6} />
    </svg>
  );
}
