// Furniture drawn from above, the way a floor plan draws it: a bed with its pillows and turned-down cover, a sofa with
// its back, arms and cushions, a dining table with chairs pulled up, a toilet, bath and basin, a car. Each is drawn at
// real size from the plan's scale (pixels per metre), centred on the piece, with its back (a bed's head, a sofa's
// back, a car's bonnet) at the top (-y) before the piece is rotated. Colours come from the piece's room group.
import type { ReactNode } from "react";
import { FURNITURE_BY_KEY, GROUP_COLOUR } from "./furniture";

type Style = { rx?: number; fill?: string; fillOpacity?: number; stroke?: string; sw?: number; dash?: string };
type Kit = {
  w: number; h: number; m: (metres: number) => number; thin: number;
  body: string; accent: string; dark: string; line: string; out: ReactNode[];
};
type Pt = [number, number];

/** Lighten (amount > 0) or darken (amount < 0) a #rrggbb colour. */
export function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.round(amount < 0 ? c * (1 + amount) : c + (255 - c) * amount);
  const [r, g, b] = [f(n >> 16), f((n >> 8) & 255), f(n & 255)];
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

const GLASS = "#bcd3e0", WHITE = "#ffffff", SCREEN = "#2f3437";

// ─── primitives: each adds an element to the kit ───────────────────────
function attrs(k: Kit, o: Style) {
  return { fill: o.fill ?? "none", fillOpacity: o.fillOpacity, stroke: o.stroke ?? k.line, strokeWidth: (o.sw ?? 1) * k.thin, strokeDasharray: o.dash,
           vectorEffect: "non-scaling-stroke" as const };
}
function rect(k: Kit, x: number, y: number, w: number, h: number, o: Style = {}) {
  k.out.push(<rect key={k.out.length} x={x} y={y} width={Math.max(0, w)} height={Math.max(0, h)} rx={o.rx ?? 0} {...attrs(k, o)} />);
}
function circle(k: Kit, cx: number, cy: number, r: number, o: Style = {}) {
  k.out.push(<circle key={k.out.length} cx={cx} cy={cy} r={Math.max(0, r)} {...attrs(k, o)} />);
}
function ellipse(k: Kit, cx: number, cy: number, rx: number, ry: number, o: Style = {}) {
  k.out.push(<ellipse key={k.out.length} cx={cx} cy={cy} rx={Math.max(0, rx)} ry={Math.max(0, ry)} {...attrs(k, o)} />);
}
function line(k: Kit, x1: number, y1: number, x2: number, y2: number, o: Style = {}) {
  k.out.push(<line key={k.out.length} x1={x1} y1={y1} x2={x2} y2={y2} {...attrs(k, { sw: 0.8, ...o })} />);
}
function poly(k: Kit, points: Pt[], o: Style = {}) {
  k.out.push(<polygon key={k.out.length} points={points.map((p) => p.join(",")).join(" ")} {...attrs(k, o)} />);
}
function path(k: Kit, d: string, o: Style = {}) {
  k.out.push(<path key={k.out.length} d={d} {...attrs(k, o)} />);
}
/** Draw into a group moved to (x, y) and turned by deg (a chair at a table). */
function at(k: Kit, x: number, y: number, deg: number, draw: (k: Kit) => void) {
  const child: Kit = { ...k, out: [] };
  draw(child);
  k.out.push(<g key={k.out.length} transform={`translate(${x} ${y}) rotate(${deg})`}>{child.out}</g>);
}

// ─── pieces ────────────────────────────────────────────────────────────
function plain(k: Kit) {
  rect(k, 0, 0, k.w, k.h, { rx: k.m(0.03), fill: k.body, sw: 1.5 });
}

function plainRound(k: Kit) {
  ellipse(k, k.w / 2, k.h / 2, k.w / 2, k.h / 2, { fill: k.body, sw: 1.5 });
  ellipse(k, k.w / 2, k.h / 2, k.w * 0.38, k.h * 0.38, { stroke: k.accent, sw: 0.8 });
}

function bed(k: Kit) {
  const { w, h, m } = k;
  rect(k, 0, 0, w, h, { rx: m(0.05), fill: k.body, sw: 1.5 });
  const head = Math.min(m(0.07), h * 0.05);
  rect(k, 0, 0, w, head, { rx: m(0.03), fill: k.dark });
  const pillows = w >= m(1.3) ? 2 : 1, gap = m(0.08);
  const pw = Math.min(m(0.62), (w - gap * (pillows + 1)) / pillows), ph = Math.min(m(0.34), h * 0.18), py = head + m(0.06);
  const px = (w - (pillows * pw + (pillows - 1) * gap)) / 2;
  for (let i = 0; i < pillows; i++) rect(k, px + i * (pw + gap), py, pw, ph, { rx: m(0.08), fill: WHITE });
  const top = py + ph + m(0.08), inset = m(0.03);
  rect(k, inset, top, w - 2 * inset, h - top - inset, { rx: m(0.04), fill: k.accent });
  // the cover turned down at the top, and a corner folded back at the foot
  rect(k, inset, top, w - 2 * inset, Math.min(m(0.22), (h - top) * 0.2), { fill: WHITE, sw: 0.8 });
  const f = Math.min(m(0.35), w * 0.25);
  poly(k, [[w - inset - f, h - inset], [w - inset, h - inset - f], [w - inset, h - inset]], { fill: k.body, sw: 0.8 });
}

function cot(k: Kit) {
  const { w, h, m } = k, rail = m(0.05);
  rect(k, 0, 0, w, h, { rx: m(0.03), fill: k.accent, sw: 1.5 });
  rect(k, rail, rail, w - 2 * rail, h - 2 * rail, { rx: m(0.03), fill: WHITE });
  for (let y = rail + m(0.08); y < h - rail; y += m(0.08)) {
    line(k, 0, y, rail, y, { sw: 0.6 });
    line(k, w - rail, y, w, y, { sw: 0.6 });
  }
}

function bedside(k: Kit) {
  const { w, h, m } = k, r = Math.min(w, h) * 0.26;
  rect(k, 0, 0, w, h, { rx: m(0.03), fill: k.body, sw: 1.5 });
  circle(k, w / 2, h / 2, r, { fill: WHITE });
  circle(k, w / 2, h / 2, r * 0.35, { fill: k.accent });
}

function wardrobe(k: Kit) {
  const { w, h, m } = k, front = h - m(0.03), rail = front / 2;
  rect(k, 0, 0, w, h, { fill: k.body, sw: 1.5 });
  line(k, 0, front, w, front);
  line(k, w / 2, front, w / 2, h);
  line(k, m(0.04), rail, w - m(0.04), rail);
  for (let x = m(0.1); x < w - m(0.05); x += m(0.1)) line(k, x - m(0.05), rail - h * 0.3, x + m(0.05), rail + h * 0.3, { sw: 0.6, stroke: k.dark });
}

function drawers(k: Kit) {
  const { w, h, m } = k;
  rect(k, 0, 0, w, h, { rx: m(0.02), fill: k.body, sw: 1.5 });
  rect(k, m(0.03), m(0.03), w - m(0.06), h - m(0.08), { rx: m(0.02), fill: k.accent, sw: 0.6 });
  line(k, w * 0.4, h - m(0.025), w * 0.6, h - m(0.025), { sw: 1.4 });
}

function sofa(seats: number) {
  return (k: Kit) => {
    const { w, h, m } = k, r = m(0.06);
    const back = Math.min(m(0.22), h * 0.28), arm = Math.min(m(0.2), w * 0.14), p = m(0.015);
    rect(k, 0, 0, w, h, { rx: r, fill: k.accent, sw: 1.5 });
    rect(k, 0, 0, w, back, { rx: r, fill: k.dark });
    rect(k, 0, 0, arm, h, { rx: r, fill: k.dark });
    rect(k, w - arm, 0, arm, h, { rx: r, fill: k.dark });
    const each = (w - 2 * arm) / seats;
    for (let i = 0; i < seats; i++) rect(k, arm + i * each + p, back + p, each - 2 * p, h - back - 2 * p, { rx: m(0.05), fill: k.body });
  };
}

function cornerSofa(k: Kit) {
  const { w, h, m } = k, r = m(0.06), p = m(0.015);
  const back = Math.min(m(0.22), h * 0.2), arm = Math.min(m(0.2), w * 0.1), deep = Math.min(m(0.95), h * 0.6, w * 0.45);
  path(k, `M0 0 H${w} V${deep} H${deep} V${h} H0 Z`, { fill: k.accent, sw: 1.5 });
  rect(k, 0, 0, w, back, { rx: r, fill: k.dark });
  rect(k, 0, 0, back, h, { rx: r, fill: k.dark });
  rect(k, w - arm, 0, arm, deep, { rx: r, fill: k.dark });
  rect(k, 0, h - arm, deep, arm, { rx: r, fill: k.dark });
  rect(k, back + p, back + p, deep - back - 2 * p, deep - back - 2 * p, { rx: m(0.05), fill: k.body });
  const run = (w - arm - deep) / 2;
  for (let i = 0; i < 2; i++) rect(k, deep + i * run + p, back + p, run - 2 * p, deep - back - 2 * p, { rx: m(0.05), fill: k.body });
  rect(k, back + p, deep + p, deep - back - 2 * p, h - arm - deep - 2 * p, { rx: m(0.05), fill: k.body });
}

function coffeeTable(k: Kit) {
  const { w, h, m } = k;
  rect(k, 0, 0, w, h, { rx: m(0.05), fill: k.body, sw: 1.5 });
  rect(k, m(0.06), m(0.06), w - m(0.12), h - m(0.12), { rx: m(0.03), sw: 0.6 });
}

function tvUnit(k: Kit) {
  const { w, h, m } = k;
  rect(k, 0, 0, w, h, { rx: m(0.02), fill: k.body, sw: 1.5 });
  rect(k, w * 0.46, m(0.09), w * 0.08, m(0.07), { fill: "#6b7174", stroke: "none" });
  rect(k, w * 0.12, m(0.04), w * 0.76, m(0.05), { rx: m(0.01), fill: SCREEN, stroke: "none" });
  line(k, w / 3, h * 0.55, w / 3, h, { sw: 0.5 });
  line(k, (2 * w) / 3, h * 0.55, (2 * w) / 3, h, { sw: 0.5 });
}

function rug(k: Kit) {
  const { w, h, m } = k, fringe = m(0.07), b = m(0.12), d = m(0.3);
  rect(k, 0, 0, w, h, { fill: k.accent, sw: 1 });
  rect(k, b, b, w - 2 * b, h - 2 * b, { dash: "4 3", sw: 0.8 });
  poly(k, [[w / 2, d], [w - d, h / 2], [w / 2, h - d], [d, h / 2]], { fill: k.body, sw: 0.8 });
  if (w >= h) {
    for (let y = m(0.05); y < h; y += m(0.08)) { line(k, -fringe, y, 0, y, { sw: 0.5 }); line(k, w, y, w + fringe, y, { sw: 0.5 }); }
  } else {
    for (let x = m(0.05); x < w; x += m(0.08)) { line(k, x, -fringe, x, 0, { sw: 0.5 }); line(k, x, h, x, h + fringe, { sw: 0.5 }); }
  }
}

function bookcase(k: Kit) {
  const { w, h, m } = k, sections = Math.max(1, Math.round(w / m(0.3)));
  rect(k, 0, 0, w, h, { fill: k.body, sw: 1.5 });
  for (let i = 1; i < sections; i++) line(k, (w / sections) * i, 0, (w / sections) * i, h);
  // books standing on the shelf
  for (let x = m(0.03); x < w - m(0.03); x += m(0.035)) line(k, x, m(0.04), x, h - m(0.06), { sw: 0.4, stroke: k.dark });
}

function piano(k: Kit) {
  const { w, h, m } = k;
  rect(k, 0, 0, w, h, { rx: m(0.02), fill: k.dark, sw: 1.5 });
  const keysY = h - m(0.2), keysW = w - m(0.12);
  rect(k, m(0.06), keysY, keysW, m(0.16), { fill: WHITE, sw: 0.8 });
  const white = m(0.0235), octave = white * 7;
  for (let o = 0; (o + 1) * octave <= keysW + 0.001; o++) {
    for (const n of [1, 2, 4, 5, 6]) rect(k, m(0.06) + o * octave + n * white - m(0.0065), keysY, m(0.013), m(0.09), { fill: SCREEN, stroke: "none" });
  }
}

/** A chair centred at the origin with its back toward -y. */
function chairShape(cw: number, cd: number) {
  return (k: Kit) => {
    rect(k, -cw / 2, -cd / 2, cw, cd, { rx: k.m(0.06), fill: k.accent });
    rect(k, -cw / 2, -cd / 2, cw, k.m(0.08), { rx: k.m(0.04), fill: k.dark });
  };
}

function diningTable(perSide: number, ends: boolean, slats = false) {
  return (k: Kit) => {
    const { w, h, m } = k, cw = m(0.45), cd = m(0.45), out = cd * 0.15;  // chairs pulled a third of the way in
    for (let i = 0; i < perSide; i++) {
      const x = (w / perSide) * (i + 0.5);
      at(k, x, -out, 0, chairShape(cw, cd));
      at(k, x, h + out, 180, chairShape(cw, cd));
    }
    if (ends) { at(k, -out, h / 2, 270, chairShape(cw, cd)); at(k, w + out, h / 2, 90, chairShape(cw, cd)); }
    rect(k, 0, 0, w, h, { rx: m(0.03), fill: k.body, sw: 1.5 });
    if (slats) for (let x = m(0.1); x < w - m(0.05); x += m(0.1)) line(k, x, m(0.02), x, h - m(0.02), { sw: 0.5 });
    else rect(k, m(0.04), m(0.04), w - m(0.08), h - m(0.08), { rx: m(0.02), sw: 0.5 });
  };
}

function roundTable(k: Kit) {
  const { w, h, m } = k, r = Math.min(w, h) / 2, cd = m(0.45), d = r + cd * 0.15;
  for (const deg of [0, 90, 180, 270]) {
    const a = (deg * Math.PI) / 180;
    at(k, w / 2 + Math.sin(a) * d, h / 2 - Math.cos(a) * d, deg, chairShape(m(0.45), cd));
  }
  circle(k, w / 2, h / 2, r, { fill: k.body, sw: 1.5 });
  circle(k, w / 2, h / 2, r * 0.85, { sw: 0.5 });
}

function chair(k: Kit) {
  at(k, k.w / 2, k.h / 2, 0, chairShape(k.w, k.h));
}

function sideboard(k: Kit) {
  const { w, h, m } = k;
  rect(k, 0, 0, w, h, { rx: m(0.02), fill: k.body, sw: 1.5 });
  for (let i = 1; i < 3; i++) line(k, (w / 3) * i, h * 0.35, (w / 3) * i, h, { sw: 0.6 });
  line(k, 0, h - m(0.03), w, h - m(0.03), { sw: 0.6 });
}

/** A fridge from above: its top, the door line along the front and the handles. `split` is where the doors meet
 *  (French door ½, side by side a bit left of centre); none for a single door; `pair` is two separate columns. */
function fridge(split?: number, pair = false) {
  return (k: Kit) => {
    const { w, h, m } = k, front = h - m(0.06);
    const unit = (x: number, uw: number, doors?: number) => {
      rect(k, x, 0, uw, h, { rx: m(0.02), fill: k.body, sw: 1.5 });
      rect(k, x + m(0.03), m(0.03), uw - m(0.06), front - m(0.04), { rx: m(0.02), fill: WHITE, sw: 0.6 });
      line(k, x, front, x + uw, front);
      const handles = doors == null ? [x + uw - m(0.06)] : [x + uw * doors - m(0.04), x + uw * doors + m(0.04)];
      if (doors != null) line(k, x + uw * doors, front, x + uw * doors, h);
      for (const hx of handles) line(k, hx, h - m(0.02), hx, h + m(0.03), { sw: 1.6 });
    };
    if (pair) { unit(0, w / 2 - m(0.005), undefined); unit(w / 2 + m(0.005), w / 2 - m(0.005), undefined); }
    else unit(0, w, split);
  };
}

function island(k: Kit) {
  const { w, h, m } = k;
  rect(k, 0, 0, w, h, { rx: m(0.02), fill: k.body, sw: 1.5 });
  const sw = Math.min(m(0.75), w * 0.36), sh = Math.min(m(0.42), h * 0.55), sx = w * 0.26 - sw / 2, sy = (h - sh) / 2;
  rect(k, sx, sy, sw, sh, { rx: m(0.05), fill: WHITE });
  line(k, sx + sw / 2, sy, sx + sw / 2, sy + sh, { sw: 0.6 });
  circle(k, sx + sw / 4, sy + sh / 2, m(0.02), { fill: k.line, stroke: "none" });
  circle(k, sx + (3 * sw) / 4, sy + sh / 2, m(0.02), { fill: k.line, stroke: "none" });
  circle(k, sx + sw / 2, sy - m(0.05), m(0.025), { fill: k.line, stroke: "none" });
  const cx = w * 0.72, cy = h / 2, gap = Math.min(m(0.14), h * 0.22);
  rect(k, cx - gap * 2, cy - gap * 2, gap * 4, gap * 4, { rx: m(0.02), fill: SCREEN, stroke: "none" });
  for (const [dx, dy, r] of [[-1, -1, 0.07], [1, -1, 0.09], [-1, 1, 0.09], [1, 1, 0.07]] as const) {
    circle(k, cx + dx * gap, cy + dy * gap, m(r), { stroke: "#8a9195", sw: 0.8 });
  }
}

function laundry(dashed: boolean) {
  return (k: Kit) => {
    const { w, h, m } = k, panel = m(0.1), r = Math.min(w, h - panel) * 0.36;
    rect(k, 0, 0, w, h, { rx: m(0.03), fill: k.body, sw: 1.5 });
    rect(k, 0, 0, w, panel, { rx: m(0.03), fill: k.accent });
    circle(k, w * 0.78, panel / 2, m(0.025), { fill: WHITE, sw: 0.6 });
    circle(k, w / 2, panel + (h - panel) / 2, r, { fill: WHITE });
    circle(k, w / 2, panel + (h - panel) / 2, r * 0.62, { dash: dashed ? "3 2" : undefined, sw: 0.7 });
  };
}

function bath(k: Kit) {
  const { w, h, m } = k, i = m(0.08), long = w >= h;
  rect(k, 0, 0, w, h, { rx: m(0.06), fill: k.body, sw: 1.5 });
  rect(k, i, i, w - 2 * i, h - 2 * i, { rx: Math.min(m(0.28), (Math.min(w, h) - 2 * i) / 2), fill: WHITE });
  const [px, py] = long ? [w - i - m(0.12), h / 2] : [w / 2, h - i - m(0.12)];
  circle(k, px, py, m(0.03), { fill: k.accent });
  const [tx, ty] = long ? [w - i / 2, h / 2] : [w / 2, h - i / 2];
  circle(k, tx, ty, m(0.025), { fill: k.line, stroke: "none" });
}

function shower(k: Kit) {
  const { w, h, m } = k, i = m(0.04);
  rect(k, 0, 0, w, h, { fill: k.body, sw: 1.5 });
  rect(k, i, i, w - 2 * i, h - 2 * i, { fill: WHITE, sw: 0.8 });
  line(k, i, i, w - i, h - i, { sw: 0.5 });
  line(k, w - i, i, i, h - i, { sw: 0.5 });
  circle(k, w / 2, h / 2, m(0.045), { fill: k.accent });
  circle(k, w / 2, i + m(0.07), m(0.05), { fill: k.accent, sw: 0.8 });
}

function vanity(k: Kit) {
  const { w, h, m } = k;
  rect(k, 0, 0, w, h, { rx: m(0.02), fill: k.body, sw: 1.5 });
  ellipse(k, w / 2, h / 2 + m(0.03), Math.min(w * 0.36, m(0.25)), Math.min(h * 0.32, m(0.16)), { fill: WHITE });
  circle(k, w / 2, h / 2 + m(0.03), m(0.015), { fill: k.line, stroke: "none" });
  circle(k, w / 2, m(0.06), m(0.025), { fill: k.line, stroke: "none" });
}

function toilet(k: Kit) {
  const { w, h, m } = k, tank = h * 0.27, bowl = h - tank;
  rect(k, 0, 0, w, tank, { rx: m(0.03), fill: k.accent, sw: 1.5 });
  ellipse(k, w / 2, tank + bowl / 2, w * 0.46, bowl / 2 * 0.96, { fill: k.body, sw: 1.5 });
  ellipse(k, w / 2, tank + bowl / 2 + m(0.02), w * 0.3, bowl / 2 * 0.62, { fill: WHITE, sw: 0.8 });
}

function desk(k: Kit) {
  const { w, h, m } = k;
  rect(k, 0, 0, w, h, { rx: m(0.02), fill: k.body, sw: 1.5 });
  rect(k, w * 0.47, m(0.09), w * 0.06, m(0.07), { fill: "#6b7174", stroke: "none" });
  rect(k, w * 0.3, m(0.06), w * 0.4, m(0.035), { rx: m(0.01), fill: SCREEN, stroke: "none" });
  rect(k, w * 0.35, h * 0.55, w * 0.28, m(0.13), { rx: m(0.01), fill: WHITE, sw: 0.6 });
  ellipse(k, w * 0.7, h * 0.62, m(0.03), m(0.05), { fill: WHITE, sw: 0.6 });
}

function officeChair(k: Kit) {
  const { w, h } = k, cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2;
  for (let i = 0; i < 5; i++) {
    const a = (i * 72 * Math.PI) / 180;
    line(k, cx, cy, cx + Math.sin(a) * r, cy - Math.cos(a) * r, { sw: 1 });
    circle(k, cx + Math.sin(a) * r, cy - Math.cos(a) * r, r * 0.06, { fill: k.line, stroke: "none" });
  }
  circle(k, cx, cy + r * 0.05, r * 0.66, { fill: k.accent, sw: 1.5 });
  rect(k, cx - r * 0.62, cy - r * 0.9, r * 1.24, r * 0.3, { rx: r * 0.14, fill: k.dark });
}

function filing(k: Kit) {
  const { w, h, m } = k;
  rect(k, 0, 0, w, h, { rx: m(0.02), fill: k.body, sw: 1.5 });
  line(k, 0, h - m(0.03), w, h - m(0.03), { sw: 0.6 });
  rect(k, w * 0.35, h - m(0.02), w * 0.3, m(0.02), { fill: k.line, stroke: "none" });
}

function car(k: Kit) {
  const { w, h, m } = k;
  rect(k, -m(0.12), h * 0.3, m(0.14), m(0.09), { rx: m(0.03), fill: k.dark });   // mirrors
  rect(k, w - m(0.02), h * 0.3, m(0.14), m(0.09), { rx: m(0.03), fill: k.dark });
  rect(k, 0, 0, w, h, { rx: w * 0.3, fill: k.body, sw: 1.5 });
  poly(k, [[w * 0.2, h * 0.28], [w * 0.8, h * 0.28], [w * 0.88, h * 0.38], [w * 0.12, h * 0.38]], { fill: GLASS, sw: 0.8 });
  rect(k, w * 0.13, h * 0.38, w * 0.74, h * 0.34, { rx: w * 0.1, fill: k.accent, sw: 0.8 });
  poly(k, [[w * 0.14, h * 0.72], [w * 0.86, h * 0.72], [w * 0.78, h * 0.8], [w * 0.22, h * 0.8]], { fill: GLASS, sw: 0.8 });
  line(k, w * 0.22, h * 0.1, w * 0.78, h * 0.1, { sw: 0.5 });                     // bonnet crease
  rect(k, w * 0.1, m(0.06), w * 0.18, m(0.07), { rx: m(0.03), fill: "#fff6cf", sw: 0.6 });
  rect(k, w * 0.72, m(0.06), w * 0.18, m(0.07), { rx: m(0.03), fill: "#fff6cf", sw: 0.6 });
  rect(k, w * 0.1, h - m(0.11), w * 0.18, m(0.06), { rx: m(0.02), fill: "#e8645a", sw: 0.6 });
  rect(k, w * 0.72, h - m(0.11), w * 0.18, m(0.06), { rx: m(0.02), fill: "#e8645a", sw: 0.6 });
}

function bbq(k: Kit) {
  const { w, h, m } = k, gw = w * 0.58;
  rect(k, 0, 0, w, h, { rx: m(0.03), fill: k.body, sw: 1.5 });
  rect(k, m(0.05), m(0.05), gw - m(0.05), h - m(0.1), { fill: SCREEN, stroke: "none" });
  for (let y = m(0.09); y < h - m(0.06); y += m(0.045)) line(k, m(0.07), y, gw - m(0.02), y, { stroke: "#9aa1a5", sw: 0.6 });
  rect(k, gw + m(0.04), m(0.05), w - gw - m(0.09), h - m(0.1), { fill: k.accent, sw: 0.8 });
}

function trampoline(k: Kit) {
  const { w, h } = k, cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2;
  circle(k, cx, cy, r, { fill: k.accent, sw: 1.5 });
  for (let deg = 0; deg < 360; deg += 10) {
    const a = (deg * Math.PI) / 180;
    line(k, cx + Math.sin(a) * r * 0.84, cy - Math.cos(a) * r * 0.84, cx + Math.sin(a) * r * 0.96, cy - Math.cos(a) * r * 0.96, { sw: 0.5 });
  }
  circle(k, cx, cy, r * 0.84, { fill: SCREEN, sw: 0.8 });
}

// ─── workshop ──────────────────────────────────────────────────────────
const STEEL = "#9aa3a8", BLADE = "#c92a2a", TIMBER = "#d9b98c";

/** A bench top with its boards, and a vice at the front left (and right, for a woodwork bench). */
function workbench(vices: 1 | 2, dogs = false) {
  return (k: Kit) => {
    const { w, h, m } = k;
    rect(k, 0, 0, w, h, { rx: m(0.02), fill: TIMBER, sw: 1.5 });
    for (let y = m(0.15); y < h - m(0.05); y += m(0.15)) line(k, 0, y, w, y, { sw: 0.4, stroke: k.dark });
    const vice = (x: number) => {
      rect(k, x, h - m(0.02), m(0.4), m(0.1), { fill: k.accent, sw: 1 });
      line(k, x + m(0.2), h + m(0.08), x + m(0.2), h + m(0.2), { sw: 1.4 });
      line(k, x + m(0.12), h + m(0.2), x + m(0.28), h + m(0.2), { sw: 1.4 });
    };
    vice(m(0.08));
    if (vices === 2) vice(w - m(0.48));
    if (dogs) for (let x = m(0.3); x < w - m(0.2); x += m(0.15)) rect(k, x, h - m(0.12), m(0.02), m(0.02), { fill: k.line, stroke: "none" });
  };
}

function assemblyTable(k: Kit) {
  const { w, h, m } = k;
  rect(k, 0, 0, w, h, { rx: m(0.02), fill: TIMBER, sw: 1.5 });
  // T-track or a grid of clamping holes
  for (let x = m(0.15); x < w - m(0.1); x += m(0.2)) for (let y = m(0.15); y < h - m(0.1); y += m(0.2)) circle(k, x, y, m(0.01), { fill: k.line, stroke: "none" });
}

function toolChest(k: Kit) {
  const { w, h, m } = k;
  rect(k, 0, 0, w, h, { rx: m(0.02), fill: "#c0392b", sw: 1.5 });
  rect(k, m(0.03), m(0.03), w - m(0.06), h - m(0.1), { rx: m(0.01), fill: "#e06b5f", sw: 0.6 });
  line(k, m(0.08), h - m(0.03), w - m(0.08), h - m(0.03), { sw: 1.6, stroke: STEEL });
  circle(k, m(0.06), h, m(0.03), { fill: SCREEN, stroke: "none" });
  circle(k, w - m(0.06), h, m(0.03), { fill: SCREEN, stroke: "none" });
}

function shelving(k: Kit) {
  const { w, h, m } = k, bays = Math.max(1, Math.round(w / m(0.9)));
  rect(k, 0, 0, w, h, { fill: k.body, sw: 1.5 });
  for (let i = 0; i <= bays; i++) rect(k, (w / bays) * i - m(0.02), 0, m(0.04), h, { fill: STEEL, sw: 0.6 });
  // boxes on the top shelf
  for (let i = 0; i < bays; i++) {
    const x = (w / bays) * i + m(0.06), bw = w / bays - m(0.12);
    rect(k, x, m(0.06), bw * 0.45, h - m(0.12), { fill: TIMBER, sw: 0.6 });
    rect(k, x + bw * 0.52, m(0.06), bw * 0.45, h - m(0.12), { fill: k.accent, sw: 0.6 });
  }
}

/** A table saw from the operator's side (bottom): the cast top with its blade, throat plate, mitre slots and riving
 *  knife, the rip fence on its rails, and the extension table to the right. */
function tableSaw(rails: boolean) {
  return (k: Kit) => {
    const { w, h, m } = k, top = rails ? Math.min(w * 0.55, m(0.75)) : w;
    if (rails) {
      rect(k, top, m(0.04), w - top, h - m(0.08), { fill: TIMBER, sw: 1.2 });
      rect(k, 0, h - m(0.06), w, m(0.06), { fill: STEEL, sw: 1 });   // front rail
    }
    rect(k, 0, 0, top, h - (rails ? m(0.06) : 0), { rx: m(0.01), fill: STEEL, sw: 1.5 });
    const bx = top * 0.5;
    rect(k, bx - m(0.05), h * 0.25, m(0.1), h * 0.45, { rx: m(0.04), fill: WHITE, sw: 0.8 });
    line(k, bx, h * 0.28, bx, h * 0.6, { stroke: BLADE, sw: 2 });
    line(k, bx, h * 0.6, bx, h * 0.72, { stroke: SCREEN, sw: 1.6 });   // riving knife
    for (const x of [top * 0.2, top * 0.8]) line(k, x, 0, x, h - m(0.06), { sw: 0.6, dash: "1 0" });
    const fx = rails ? top + (w - top) * 0.2 : top * 0.72;
    rect(k, fx, 0, m(0.05), h, { fill: SCREEN, stroke: "none" });   // rip fence
  };
}

function mitreSaw(k: Kit) {
  const { w, h, m } = k, cx = w / 2, cy = h * 0.55, r = Math.min(m(0.2), h * 0.4);
  rect(k, 0, h * 0.3, w, h * 0.5, { rx: m(0.02), fill: k.body, sw: 1.2 });   // the stand's wings
  rect(k, cx - m(0.32), m(0.04), m(0.64), h - m(0.08), { rx: m(0.03), fill: STEEL, sw: 1.5 });
  circle(k, cx, cy, r, { fill: "#c3c9cc", sw: 0.8 });
  rect(k, cx - m(0.3), h * 0.3, m(0.6), m(0.04), { fill: SCREEN, stroke: "none" });   // fence
  line(k, cx, cy - r * 1.4, cx, cy + r, { stroke: BLADE, sw: 2.2 });
  rect(k, cx - m(0.06), m(0.06), m(0.12), h * 0.3, { rx: m(0.03), fill: k.dark });   // motor and handle
}

function bandsaw(k: Kit) {
  const { w, h, m } = k;
  rect(k, 0, 0, w * 0.4, h * 0.85, { rx: m(0.05), fill: k.accent, sw: 1.5 });   // the frame and wheels, to the left
  rect(k, w * 0.2, h * 0.12, w * 0.8, h * 0.76, { rx: m(0.02), fill: STEEL, sw: 1.5 });   // the table
  line(k, w * 0.6, h * 0.12, w * 0.6, h * 0.5, { sw: 0.6 });
  line(k, w * 0.6, h * 0.42, w * 0.6, h * 0.58, { stroke: BLADE, sw: 2 });
  rect(k, w * 0.22, h * 0.88, w * 0.3, m(0.06), { fill: SCREEN, stroke: "none" });   // switch
}

function drillPress(k: Kit) {
  const { w, h, m } = k;
  rect(k, 0, h * 0.35, w, h * 0.65, { rx: m(0.02), fill: STEEL, sw: 1.5 });   // base
  circle(k, w / 2, h * 0.32, Math.min(w, h) * 0.2, { fill: k.accent, sw: 1.2 });   // table
  rect(k, w * 0.28, 0, w * 0.44, h * 0.38, { rx: m(0.05), fill: k.dark, sw: 1.2 });   // head and motor
  circle(k, w / 2, h * 0.17, m(0.06), { fill: SCREEN, stroke: "none" });   // column
  for (const a of [-40, 0, 40]) {
    const r = (a * Math.PI) / 180;
    line(k, w * 0.72, h * 0.25, w * 0.72 + Math.cos(r) * m(0.16), h * 0.25 + Math.sin(r) * m(0.16), { sw: 1.4 });
  }
}

function jointer(k: Kit) {
  const { w, h, m } = k;
  rect(k, 0, h * 0.15, w, h * 0.7, { rx: m(0.02), fill: STEEL, sw: 1.5 });
  rect(k, w * 0.46, h * 0.15, w * 0.08, h * 0.7, { fill: SCREEN, sw: 0.8 });   // the cutter head between the tables
  rect(k, w * 0.25, 0, w * 0.5, h * 0.15, { fill: k.dark, sw: 1 });   // fence
  rect(k, w * 0.5, h * 0.2, w * 0.18, h * 0.6, { fill: k.accent, sw: 0.8, rx: m(0.02) });   // guard
}

function planer(k: Kit) {
  const { w, h, m } = k;
  rect(k, 0, h * 0.2, w, h * 0.6, { rx: m(0.02), fill: STEEL, sw: 1.2 });   // infeed and outfeed tables
  rect(k, w * 0.1, 0, w * 0.8, h, { rx: m(0.03), fill: k.accent, sw: 1.5 });
  circle(k, w / 2, h / 2, Math.min(w, h) * 0.12, { fill: k.dark, sw: 1 });   // height wheel
}

function lathe(k: Kit) {
  const { w, h, m } = k;
  rect(k, 0, h * 0.35, w, h * 0.3, { fill: STEEL, sw: 1.5 });   // bed
  rect(k, 0, h * 0.12, w * 0.22, h * 0.76, { rx: m(0.03), fill: k.dark, sw: 1.5 });   // headstock
  rect(k, w * 0.82, h * 0.2, w * 0.14, h * 0.6, { rx: m(0.03), fill: k.accent, sw: 1.2 });   // tailstock
  rect(k, w * 0.45, h * 0.5, w * 0.08, h * 0.45, { fill: k.accent, sw: 1 });   // tool rest
  line(k, w * 0.22, h / 2, w * 0.82, h / 2, { stroke: TIMBER, sw: 3 });   // a spindle turning
}

/** A metal-working lathe: the bed and chip tray, the headstock and chuck on the left, the carriage and cross slide with
 *  its tool post, and the tailstock on the right. */
function metalLathe(k: Kit) {
  const { w, h, m } = k;
  rect(k, 0, h * 0.08, w, h * 0.84, { rx: m(0.03), fill: "#cfd5d8", sw: 1.5 });   // chip tray
  rect(k, w * 0.04, h * 0.32, w * 0.92, h * 0.28, { fill: STEEL, sw: 1.2 });   // bed and ways
  line(k, w * 0.04, h * 0.42, w * 0.96, h * 0.42, { sw: 0.5 });
  line(k, w * 0.04, h * 0.5, w * 0.96, h * 0.5, { sw: 0.5 });
  rect(k, 0, 0, w * 0.26, h * 0.62, { rx: m(0.03), fill: k.dark, sw: 1.5 });   // headstock
  circle(k, w * 0.29, h * 0.36, Math.min(m(0.1), h * 0.2), { fill: "#b8c0c4", sw: 1.2 });   // chuck
  for (const a of [0, 120, 240]) {
    const t = (a * Math.PI) / 180, r = Math.min(m(0.1), h * 0.2);
    line(k, w * 0.29, h * 0.36, w * 0.29 + Math.cos(t) * r, h * 0.36 + Math.sin(t) * r, { sw: 1 });
  }
  line(k, w * 0.33, h * 0.36, w * 0.82, h * 0.36, { stroke: TIMBER, sw: 2.5 });   // the work between centres
  rect(k, w * 0.48, h * 0.24, w * 0.14, h * 0.62, { rx: m(0.02), fill: k.accent, sw: 1.2 });   // carriage and apron
  rect(k, w * 0.51, h * 0.4, w * 0.08, h * 0.14, { fill: k.dark, sw: 0.8 });   // tool post
  circle(k, w * 0.55, h * 0.82, m(0.05), { fill: SCREEN, stroke: "none" });   // handwheel
  rect(k, w * 0.82, h * 0.26, w * 0.12, h * 0.32, { rx: m(0.02), fill: k.accent, sw: 1.2 });   // tailstock
  circle(k, w * 0.97, h * 0.42, m(0.035), { fill: SCREEN, stroke: "none" });
}

function dustExtractor(k: Kit) {
  const { w, h, m } = k, cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2;
  circle(k, cx, cy, r, { fill: k.accent, sw: 1.5 });
  circle(k, cx, cy, r * 0.62, { fill: WHITE, sw: 0.8 });
  for (let a = 0; a < 360; a += 30) {
    const t = (a * Math.PI) / 180;
    line(k, cx + Math.cos(t) * r * 0.62, cy + Math.sin(t) * r * 0.62, cx + Math.cos(t) * r * 0.3, cy + Math.sin(t) * r * 0.3, { sw: 0.5 });
  }
  rect(k, cx + r * 0.7, cy - m(0.05), m(0.12), m(0.1), { fill: SCREEN, stroke: "none" });   // hose inlet
}

function compressor(k: Kit) {
  const { w, h, m } = k;
  ellipse(k, w / 2, h / 2, w / 2, h / 2 * 0.9, { fill: "#d63c2f", sw: 1.5 });   // the tank
  rect(k, w * 0.3, h * 0.2, w * 0.4, h * 0.6, { rx: m(0.03), fill: k.dark, sw: 1 });   // motor
  circle(k, w * 0.82, h * 0.3, m(0.035), { fill: WHITE, sw: 0.8 });   // gauge
}

// ─── 3D printing & CNC ─────────────────────────────────────────────────
function printerOpen(k: Kit) {
  const { w, h, m } = k, f = m(0.04);
  rect(k, 0, 0, w, h, { rx: m(0.02), fill: k.body, sw: 1, dash: "4 3" });   // the bed's travel
  rect(k, w * 0.1, h * 0.25, w * 0.8, h * 0.5, { rx: m(0.01), fill: SCREEN, sw: 1 });   // bed
  rect(k, w * 0.15, h * 0.3, w * 0.7, h * 0.4, { stroke: "#5c6266", sw: 0.4 });
  rect(k, 0, h * 0.45, w, f, { fill: k.dark, sw: 1 });   // the gantry across it
  rect(k, w * 0.42, h * 0.43, m(0.07), m(0.07), { rx: m(0.01), fill: "#f08c00", sw: 0.8 });   // print head
  circle(k, w * 0.5, h * 0.55, m(0.03), { fill: "#f08c00", stroke: "none" });   // a print on the bed
  rect(k, w * 0.25, h - m(0.07), w * 0.3, m(0.05), { fill: SCREEN, stroke: "none" });   // screen
}

function printerEnclosed(k: Kit) {
  const { w, h, m } = k;
  rect(k, 0, 0, w, h, { rx: m(0.03), fill: k.dark, sw: 1.5 });
  rect(k, m(0.03), m(0.03), w - m(0.06), h - m(0.1), { rx: m(0.02), fill: GLASS, sw: 0.8 });   // glass lid
  line(k, m(0.03), h * 0.45, w - m(0.03), h * 0.45, { sw: 0.8 });
  rect(k, w * 0.44, h * 0.4, m(0.06), m(0.06), { rx: m(0.01), fill: "#f08c00", sw: 0.8 });
  rect(k, w * 0.3, h - m(0.06), w * 0.4, m(0.04), { fill: SCREEN, stroke: "none" });
}

function resinPrinter(k: Kit) {
  const { w, h, m } = k;
  rect(k, 0, 0, w * 0.45, h, { rx: m(0.02), fill: "#f59f00", fillOpacity: 1, sw: 1.5 });   // amber UV lid
  rect(k, w * 0.08, h * 0.15, w * 0.29, h * 0.6, { fill: SCREEN, sw: 0.6 });
  rect(k, w * 0.55, 0, w * 0.45, h, { rx: m(0.02), fill: k.body, sw: 1.5 });   // wash and cure
  circle(k, w * 0.775, h / 2, Math.min(w * 0.18, h * 0.38), { fill: WHITE, sw: 0.8 });
}

/** A CNC router: the spoilboard with its grid, the gantry across it with the spindle; enclosed or open. */
function cnc(enclosed: boolean) {
  return (k: Kit) => {
    const { w, h, m } = k, e = enclosed ? m(0.04) : 0;
    if (enclosed) rect(k, 0, 0, w, h, { rx: m(0.03), fill: k.dark, sw: 1.5 });
    rect(k, e + m(0.03), e + m(0.03), w - 2 * e - m(0.06), h - 2 * e - m(0.06), { fill: TIMBER, sw: 1 });
    for (let x = e + m(0.1); x < w - e - m(0.05); x += m(0.1)) line(k, x, e + m(0.03), x, h - e - m(0.03), { sw: 0.35, stroke: k.dark });
    rect(k, e, h * 0.45, w - 2 * e, m(0.06), { fill: STEEL, sw: 1.2 });   // gantry
    circle(k, w * 0.55, h * 0.45 + m(0.03), m(0.045), { fill: SCREEN, sw: 0.8 });   // spindle
    if (enclosed) rect(k, w * 0.15, h - m(0.035), w * 0.7, m(0.02), { fill: GLASS, stroke: "none" });
    else for (const x of [0, w - m(0.04)]) rect(k, x, 0, m(0.04), h, { fill: STEEL, sw: 0.8 });   // rails
  };
}

function laser(co2: boolean) {
  return (k: Kit) => {
    const { w, h, m } = k;
    rect(k, 0, 0, w, h, { rx: m(0.02), fill: co2 ? WHITE : k.dark, sw: 1.5 });
    const lid = co2 ? w * 0.72 : w - m(0.06);
    rect(k, m(0.03), m(0.03), lid - m(0.03), h - m(0.06), { rx: m(0.01), fill: co2 ? "#f2a65a" : "#f08c00", fillOpacity: 0.75, sw: 0.8 });
    for (let x = m(0.08); x < lid - m(0.03); x += m(0.04)) line(k, x, m(0.06), x, h - m(0.06), { sw: 0.3, stroke: SCREEN });   // honeycomb
    rect(k, m(0.03), h * 0.35, lid - m(0.03), m(0.03), { fill: STEEL, sw: 0.6 });   // gantry
    if (co2) { rect(k, w * 0.76, m(0.08), w * 0.2, h * 0.25, { fill: SCREEN, stroke: "none" }); circle(k, w * 0.86, h * 0.6, m(0.04), { fill: BLADE, stroke: "none" }); }
  };
}

// ─── pottery studio ────────────────────────────────────────────────────
const CLAY = "#b5835a";

/** A potter's wheel: the splash pan and wheel head, with the potter's stool on the near side. */
function potteryWheel(k: Kit) {
  const { w, h, m } = k, cx = w / 2, r = Math.min(w / 2, m(0.32));
  rect(k, cx - r, m(0.02), r * 2, r * 2 + m(0.08), { rx: m(0.06), fill: k.body, sw: 1.5 });   // body
  circle(k, cx, r + m(0.04), r * 0.92, { fill: WHITE, sw: 1 });   // splash pan
  circle(k, cx, r + m(0.04), r * 0.5, { fill: STEEL, sw: 1 });   // wheel head
  circle(k, cx, r + m(0.04), r * 0.3, { fill: CLAY, stroke: "none" });   // clay on it
  circle(k, cx, h - m(0.18), Math.min(m(0.17), w * 0.28), { fill: k.accent, sw: 1.2 });   // stool
}

/** A kiln: round and top-loading (the lid hinged at the back), or a front-loading box with its door. Both with a
 *  controller and the clearance it needs marked faintly. */
function kiln(front: boolean) {
  return (k: Kit) => {
    const { w, h, m } = k, cx = w / 2, cy = h / 2;
    if (front) {
      rect(k, 0, 0, w, h, { rx: m(0.03), fill: STEEL, sw: 1.5 });
      rect(k, m(0.08), m(0.08), w - m(0.16), h - m(0.2), { fill: "#f4e1c8", sw: 0.8 });   // brick chamber
      rect(k, 0, h - m(0.1), w, m(0.1), { fill: k.dark, sw: 1 });   // door
      rect(k, w - m(0.2), h - m(0.08), m(0.14), m(0.06), { fill: SCREEN, stroke: "none" });   // controller
    } else {
      const r = Math.min(w, h) / 2 - m(0.04);
      for (let a = 0; a < 360; a += 30) {   // twelve-sided, as most are
        const t = (a * Math.PI) / 180, t2 = ((a + 30) * Math.PI) / 180;
        line(k, cx + Math.cos(t) * r, cy + Math.sin(t) * r, cx + Math.cos(t2) * r, cy + Math.sin(t2) * r, { sw: 1.5 });
      }
      circle(k, cx, cy, r * 0.97, { fill: STEEL, stroke: "none" });
      circle(k, cx, cy, r * 0.7, { fill: "#f4e1c8", sw: 0.8 });
      circle(k, cx, cy, r * 0.12, { fill: k.dark, stroke: "none" });   // peephole
      rect(k, cx - m(0.1), h - m(0.08), m(0.2), m(0.08), { fill: SCREEN, stroke: "none" });   // controller
      rect(k, cx - m(0.15), 0, m(0.3), m(0.05), { fill: k.dark, stroke: "none" });   // hinge
    }
  };
}

function wedgingTable(k: Kit) {
  const { w, h, m } = k;
  rect(k, 0, 0, w, h, { rx: m(0.02), fill: TIMBER, sw: 1.5 });
  rect(k, m(0.05), m(0.05), w - m(0.1), h - m(0.1), { fill: "#e9e2d0", sw: 0.8 });   // canvas or plaster top
  line(k, m(0.05), m(0.12), w - m(0.05), m(0.12), { stroke: STEEL, sw: 1.4 });   // cutting wire
  ellipse(k, w * 0.5, h * 0.6, m(0.12), m(0.09), { fill: CLAY, stroke: "none" });
}

function slabRoller(k: Kit) {
  const { w, h, m } = k;
  rect(k, 0, 0, w, h, { rx: m(0.02), fill: TIMBER, sw: 1.5 });
  rect(k, m(0.05), m(0.05), w - m(0.1), h - m(0.1), { fill: "#e9e2d0", sw: 0.6 });   // canvas
  rect(k, w * 0.45, -m(0.03), m(0.1), h + m(0.06), { rx: m(0.04), fill: STEEL, sw: 1.2 });   // rollers
  circle(k, w * 0.5, h + m(0.1), m(0.08), { fill: k.dark, sw: 1 });   // crank wheel
  rect(k, w * 0.1, h * 0.25, w * 0.32, h * 0.5, { fill: CLAY, stroke: "none" });   // a slab
}

function glazeStation(k: Kit) {
  const { w, h, m } = k, cols = 3, rows = 2, r = Math.min(w / cols, h / rows) * 0.4;
  const colours = ["#4c8fb0", "#e3d7c3", "#6b8f5a", "#a8432f", "#2f3437", "#d9a441"];
  rect(k, 0, 0, w, h, { rx: m(0.02), fill: k.body, sw: 1, dash: "4 3" });
  for (let i = 0; i < cols * rows; i++) {
    const x = (w / cols) * ((i % cols) + 0.5), y = (h / rows) * (Math.floor(i / cols) + 0.5);
    circle(k, x, y, r, { fill: WHITE, sw: 1.2 });
    circle(k, x, y, r * 0.78, { fill: colours[i % colours.length], stroke: "none" });
  }
}

function wareRack(k: Kit) {
  const { w, h, m } = k, boards = Math.max(2, Math.round(w / m(0.3)));
  rect(k, 0, 0, w, h, { fill: k.body, sw: 1.5 });
  for (const x of [0, w - m(0.04)]) rect(k, x, 0, m(0.04), h, { fill: STEEL, sw: 0.6 });
  for (let i = 0; i < boards; i++) {
    const bx = m(0.06) + i * ((w - m(0.12)) / boards);
    rect(k, bx, m(0.04), (w - m(0.12)) / boards - m(0.02), h - m(0.08), { fill: TIMBER, sw: 0.6 });
    circle(k, bx + (w - m(0.12)) / boards / 2, h / 2, Math.min(m(0.06), h * 0.2), { fill: CLAY, stroke: "none" });   // pots drying
  }
}

function claySink(k: Kit) {
  const { w, h, m } = k;
  rect(k, 0, 0, w, h, { rx: m(0.03), fill: k.body, sw: 1.5 });
  rect(k, m(0.06), m(0.08), w - m(0.12), h - m(0.14), { rx: m(0.05), fill: WHITE, sw: 1 });
  circle(k, w / 2, h / 2 + m(0.02), m(0.03), { fill: k.line, stroke: "none" });
  circle(k, w / 2, m(0.04), m(0.025), { fill: k.line, stroke: "none" });   // tap
  rect(k, w * 0.3, h + m(0.02), w * 0.4, m(0.08), { rx: m(0.03), fill: CLAY, sw: 0.8, dash: "3 2" });   // the trap below
}

function pugMill(k: Kit) {
  const { w, h, m } = k;
  rect(k, 0, h * 0.25, w, h * 0.5, { rx: h * 0.25, fill: STEEL, sw: 1.5 });   // barrel
  rect(k, w * 0.15, 0, w * 0.3, h, { rx: m(0.03), fill: k.accent, sw: 1.2 });   // hopper
  rect(k, w * 0.62, h * 0.15, w * 0.22, h * 0.7, { rx: m(0.03), fill: k.dark, sw: 1 });   // motor
  circle(k, w - m(0.04), h / 2, m(0.04), { fill: CLAY, stroke: "none" });   // clay coming out
}

function sprayBooth(k: Kit) {
  const { w, h, m } = k;
  rect(k, 0, 0, w, h, { fill: k.body, sw: 1.5 });
  rect(k, m(0.04), m(0.04), w - m(0.08), h * 0.35, { fill: "#d0d6d9", sw: 0.8 });   // filters at the back
  for (let x = m(0.08); x < w - m(0.06); x += m(0.05)) line(k, x, m(0.06), x, h * 0.35, { sw: 0.4 });
  circle(k, w / 2, h * 0.65, m(0.1), { fill: STEEL, sw: 0.8 });   // banding wheel
  line(k, 0, h, w, h, { sw: 0.8, dash: "4 3" });   // open front
}

// ─── vehicles ──────────────────────────────────────────────────────────
/** A ute: the cab like a car's front half, and the tray behind it. */
function ute(k: Kit) {
  const { w, h, m } = k, cab = h * 0.55;
  rect(k, -m(0.12), h * 0.22, m(0.14), m(0.09), { rx: m(0.03), fill: k.dark });
  rect(k, w - m(0.02), h * 0.22, m(0.14), m(0.09), { rx: m(0.03), fill: k.dark });
  rect(k, 0, 0, w, cab, { rx: w * 0.25, fill: k.body, sw: 1.5 });
  poly(k, [[w * 0.2, cab * 0.4], [w * 0.8, cab * 0.4], [w * 0.88, cab * 0.52], [w * 0.12, cab * 0.52]], { fill: GLASS, sw: 0.8 });
  rect(k, w * 0.13, cab * 0.52, w * 0.74, cab * 0.42, { rx: w * 0.08, fill: k.accent, sw: 0.8 });
  rect(k, 0, cab + m(0.05), w, h - cab - m(0.05), { rx: m(0.05), fill: k.body, sw: 1.5 });   // tray
  rect(k, m(0.08), cab + m(0.13), w - m(0.16), h - cab - m(0.21), { fill: k.accent, sw: 0.6 });
  for (let x = w * 0.25; x < w * 0.8; x += w * 0.25) line(k, x, cab + m(0.13), x, h - m(0.08), { sw: 0.4 });
  rect(k, w * 0.1, m(0.06), w * 0.18, m(0.07), { rx: m(0.03), fill: "#fff6cf", sw: 0.6 });
  rect(k, w * 0.72, m(0.06), w * 0.18, m(0.07), { rx: m(0.03), fill: "#fff6cf", sw: 0.6 });
}

function trailer(k: Kit) {
  const { w, h, m } = k, tub = h * 0.64;
  line(k, w / 2, 0, w * 0.15, h - tub, { sw: 2 });   // drawbar
  line(k, w / 2, 0, w * 0.85, h - tub, { sw: 2 });
  circle(k, w / 2, m(0.05), m(0.05), { fill: SCREEN, stroke: "none" });   // coupling
  rect(k, -m(0.08), h - tub * 0.6, m(0.1), tub * 0.3, { rx: m(0.03), fill: SCREEN, stroke: "none" });   // wheels
  rect(k, w - m(0.02), h - tub * 0.6, m(0.1), tub * 0.3, { rx: m(0.03), fill: SCREEN, stroke: "none" });
  rect(k, 0, h - tub, w, tub, { rx: m(0.02), fill: k.body, sw: 1.5 });
  rect(k, m(0.05), h - tub + m(0.05), w - m(0.1), tub - m(0.1), { fill: k.accent, sw: 0.6 });
}

function motorbike(k: Kit) {
  const { w, h, m } = k, cx = w / 2;
  rect(k, cx - m(0.06), 0, m(0.12), h * 0.22, { rx: m(0.05), fill: SCREEN, stroke: "none" });   // front wheel
  rect(k, cx - m(0.08), h * 0.78, m(0.16), h * 0.22, { rx: m(0.06), fill: SCREEN, stroke: "none" });   // rear wheel
  line(k, 0, h * 0.2, w, h * 0.2, { sw: 2.4 });   // handlebars
  ellipse(k, cx, h * 0.38, w * 0.2, h * 0.12, { fill: k.accent, sw: 1.2 });   // tank
  rect(k, cx - w * 0.14, h * 0.48, w * 0.28, h * 0.3, { rx: w * 0.12, fill: k.dark, sw: 1 });   // seat
  for (const x of [0, w]) circle(k, x, h * 0.2, m(0.03), { fill: k.line, stroke: "none" });   // mirrors
}

function bicycle(k: Kit) {
  const { w, h, m } = k, cx = w / 2;
  rect(k, cx - m(0.02), 0, m(0.04), h * 0.38, { rx: m(0.02), fill: SCREEN, stroke: "none" });
  rect(k, cx - m(0.02), h * 0.62, m(0.04), h * 0.38, { rx: m(0.02), fill: SCREEN, stroke: "none" });
  line(k, cx, h * 0.15, cx, h * 0.75, { sw: 1.6 });
  line(k, 0, h * 0.15, w, h * 0.15, { sw: 2.2 });
  ellipse(k, cx, h * 0.62, m(0.05), m(0.12), { fill: k.dark, sw: 0.8 });   // saddle
}

// ─── animals ───────────────────────────────────────────────────────────
/** Bubu and Dudu, sitting down, seen from above, facing the front (+y): drawn round and chubby as the characters are,
 *  a big round head over a small round body, stubby feet and paws in front, dot eyes and rosy cheeks. */
function sittingAnimal(c: { fur: string; dark: string; limbs: string; ears: string; muzzle: string; patches?: string }) {
  return (k: Kit) => {
    const { w, h } = k, cx = w / 2, outline = { stroke: shade(c.dark, -0.25), sw: 1.4 };
    // round feet out in front, with pink pads
    for (const s of [-1, 1]) {
      ellipse(k, cx + s * w * 0.27, h * 0.83, w * 0.15, h * 0.13, { fill: c.limbs, ...outline });
      ellipse(k, cx + s * w * 0.27, h * 0.85, w * 0.07, h * 0.06, { fill: "#f4b6c2", stroke: "none" });
    }
    // a small round body behind
    ellipse(k, cx, h * 0.4, w * 0.42, h * 0.34, { fill: c.fur, ...outline, sw: 1.6 });
    if (c.patches) ellipse(k, cx, h * 0.47, w * 0.42, h * 0.11, { fill: c.limbs, stroke: "none" });   // the panda's shoulder band
    // stubby paws resting in front
    for (const s of [-1, 1]) ellipse(k, cx + s * w * 0.13, h * 0.74, w * 0.1, h * 0.09, { fill: c.limbs, ...outline });
    // the big round head, round ears
    const hy = h * 0.5, r = w * 0.31;
    for (const s of [-1, 1]) {
      circle(k, cx + s * r * 0.78, hy - r * 0.72, r * 0.34, { fill: c.ears, ...outline });
      circle(k, cx + s * r * 0.78, hy - r * 0.72, r * 0.16, { fill: c.patches ? shade(c.ears, 0.25) : shade(c.ears, 0.3), stroke: "none" });
    }
    circle(k, cx, hy, r, { fill: c.fur, ...outline, sw: 1.6 });
    // face: eye patches (Bubu), dot eyes with a shine, rosy cheeks, a little muzzle and nose
    if (c.patches) for (const s of [-1, 1]) ellipse(k, cx + s * r * 0.36, hy + r * 0.12, r * 0.2, r * 0.25, { fill: c.patches, stroke: "none" });
    for (const s of [-1, 1]) {
      circle(k, cx + s * r * 0.36, hy + r * 0.14, r * 0.1, { fill: c.patches ? WHITE : SCREEN, stroke: "none" });
      circle(k, cx + s * r * 0.36, hy + r * 0.14, r * 0.055, { fill: SCREEN, stroke: "none" });
      circle(k, cx + s * r * 0.33, hy + r * 0.1, r * 0.025, { fill: WHITE, stroke: "none" });
      ellipse(k, cx + s * r * 0.62, hy + r * 0.44, r * 0.16, r * 0.1, { fill: "#f4a3b4", stroke: "none" });
    }
    ellipse(k, cx, hy + r * 0.5, r * 0.26, r * 0.2, { fill: c.muzzle, ...outline, sw: 1 });
    ellipse(k, cx, hy + r * 0.42, r * 0.09, r * 0.065, { fill: SCREEN, stroke: "none" });
    path(k, `M${cx - r * 0.1} ${hy + r * 0.58} Q${cx} ${hy + r * 0.66} ${cx + r * 0.1} ${hy + r * 0.58}`, { stroke: SCREEN, sw: 1 });
  };
}

// ─── plan symbols: doors, windows, stairs ──────────────────────────────
/** A door open at 90°, hinged at the bottom corner(s), with its swing: the wall runs along the bottom edge. */
function door(leaves: 1 | 2) {
  return (k: Kit) => {
    const { w, h, m } = k, t = m(0.04), r = leaves === 1 ? w : w / 2, swing = { dash: "5 3", sw: 0.8 };
    line(k, 0, h, w, h, { sw: 0.6, dash: "2 3" });
    path(k, `M${r} ${h} A${r} ${r} 0 0 0 0 ${h - r}`, swing);
    rect(k, 0, h - r, t, r, { fill: WHITE, sw: 1.3 });
    if (leaves === 2) {
      path(k, `M${w - r} ${h} A${r} ${r} 0 0 1 ${w} ${h - r}`, swing);
      rect(k, w - t, h - r, t, r, { fill: WHITE, sw: 1.3 });
    }
  };
}

function slidingDoor(k: Kit) {
  const { w, h, m } = k;
  line(k, 0, 0, w, 0, { sw: 1 });
  line(k, 0, h, w, h, { sw: 1 });
  rect(k, 0, h * 0.12, w * 0.55, h * 0.34, { fill: WHITE, sw: 1.1 });
  rect(k, w * 0.45, h * 0.54, w * 0.55, h * 0.34, { fill: WHITE, sw: 1.1 });
  const y = h * 0.29, x = w * 0.3, a = Math.min(m(0.08), w * 0.05);
  line(k, x - a * 2, y, x + a * 2, y, { sw: 0.8 });
  poly(k, [[x + a * 2, y], [x + a, y - h * 0.12], [x + a, y + h * 0.12]], { fill: k.line, stroke: "none" });
}

function windowSymbol(k: Kit) {
  const { w, h } = k;
  rect(k, 0, 0, w, h, { fill: WHITE, sw: 1.3 });
  line(k, 0, h * 0.4, w, h * 0.4, { sw: 0.7 });
  line(k, 0, h * 0.6, w, h * 0.6, { sw: 0.7 });
}

/** Stairs going up toward the top: treads, and the arrow showing the way up. */
function stairs(k: Kit) {
  const { w, h, m } = k, tread = m(0.25);
  rect(k, 0, 0, w, h, { fill: k.body, sw: 1.5 });
  for (let y = tread; y < h - m(0.05); y += tread) line(k, 0, y, w, y, { sw: 0.7 });
  line(k, w / 2, h - m(0.15), w / 2, m(0.3), { sw: 1 });
  poly(k, [[w / 2, m(0.12)], [w / 2 - m(0.1), m(0.34)], [w / 2 + m(0.1), m(0.34)]], { fill: k.line, stroke: "none" });
  circle(k, w / 2, h - m(0.15), m(0.04), { fill: k.line, stroke: "none" });
}

const SYMBOLS: Record<string, (k: Kit) => void> = {
  king: bed, queen: bed, double: bed, "king-single": bed, single: bed, cot, bedside, wardrobe, dresser: drawers,
  "sofa-3": sofa(3), "sofa-2": sofa(2), "corner-sofa": cornerSofa, armchair: sofa(1), "coffee-table": coffeeTable,
  "tv-unit": tvUnit, rug, bookcase, piano,
  "table-4": diningTable(2, false), "table-6": diningTable(2, true), "table-8": diningTable(3, true), "round-table": roundTable,
  chair, sideboard,
  island, washer: laundry(false), dryer: laundry(true),
  "bar-fridge": fridge(), "fridge-small": fridge(), "fridge-medium": fridge(), "fridge-large": fridge(),
  fridge: fridge(0.5), "fridge-sxs": fridge(0.42), "fridge-4door": fridge(0.5), "fridge-pair": fridge(undefined, true),
  bath, shower, vanity, toilet,
  desk, "office-chair": officeChair, filing,
  car, suv: car, "outdoor-table": diningTable(2, true, true), bbq, trampoline,
  door: door(1), "door-wide": door(1), "double-door": door(2), "sliding-door": slidingDoor, window: windowSymbol, stairs,
  workbench: workbench(1), "workbench-large": workbench(1), "woodwork-bench": workbench(2, true), "assembly-table": assemblyTable,
  "tool-chest": toolChest, shelving, "table-saw": tableSaw(true), "jobsite-saw": tableSaw(false), "mitre-saw": mitreSaw, bandsaw,
  "drill-press": drillPress, jointer, planer, lathe, "metal-lathe": metalLathe, "mini-lathe": metalLathe, "dust-extractor": dustExtractor, compressor,
  "printer-open": printerOpen, "printer-enclosed": printerEnclosed, "printer-large": printerEnclosed, "resin-printer": resinPrinter,
  "cnc-desktop": cnc(true), "cnc-open": cnc(false), "laser-desktop": laser(false), "laser-co2": laser(true),
  "pottery-wheel": potteryWheel, "kiln-top": kiln(false), "kiln-front": kiln(true), "wedging-table": wedgingTable,
  "slab-roller": slabRoller, "glaze-station": glazeStation, "ware-rack": wareRack, "clay-sink": claySink, "pug-mill": pugMill,
  "spray-booth": sprayBooth,
  "custom-box": plain, "custom-round": plainRound,
  panda: sittingAnimal({ fur: "#f7f5f0", dark: "#2b2b2b", limbs: "#2b2b2b", ears: "#2b2b2b", muzzle: "#f7f5f0", patches: "#2b2b2b" }),
  bear: sittingAnimal({ fur: "#a8744a", dark: "#6b4426", limbs: "#93613a", ears: "#93613a", muzzle: "#efd9bd" }),
  "car-hatch": car, "car-small": car, "car-cx30": car, "car-midsuv": car, "people-mover": car, van: car, ute, "ute-large": ute, trailer, motorbike, bicycle,
};
/** Pieces drawn with chairs around them, which reach past the table's own size. */
const WITH_CHAIRS = new Set(["table-4", "table-6", "table-8", "round-table", "outdoor-table"]);

/** Pieces drawn a little past their own size (a bench's vice handles, a car's mirrors, a sink's trap). */
const REACHES_OUT = new Set(["workbench", "workbench-large", "woodwork-bench", "slab-roller", "clay-sink", "ute", "ute-large", "trailer", "car",
  "suv", "car-hatch", "car-small", "car-cx30", "car-midsuv", "people-mover", "van"]);

/** A piece of furniture w × h plan pixels, at ppm pixels per metre, centred on the origin: in its room group's colour,
 *  or `colour` if it's been given one, and mirrored left to right with `flip`. */
export function FurnitureSymbol({ item, w, h, ppm, thin = 1, colour, flip = false }: { item: string; w: number; h: number; ppm: number; thin?: number;
                                                                                    colour?: string; flip?: boolean }) {
  const f = FURNITURE_BY_KEY.get(item);
  const base = colour ?? (f ? GROUP_COLOUR[f.group] : "#8a8f93");
  const k: Kit = {
    w, h, m: (metres) => metres * ppm, thin, out: [],
    body: shade(base, 0.78), accent: shade(base, 0.45), dark: shade(base, 0.05), line: shade(base, -0.5),
  };
  (SYMBOLS[item] ?? plain)(k);
  return <g transform={`${flip ? "scale(-1 1) " : ""}translate(${-w / 2} ${-h / 2})`}>{k.out}</g>;
}

/** The piece drawn small for the furniture list, fitted to the box. */
export function FurniturePreview({ item, width = 56, height = 40 }: { item: string; width?: number; height?: number }) {
  const f = FURNITURE_BY_KEY.get(item);
  if (!f) return null;
  const pad = WITH_CHAIRS.has(item) ? 0.32 : item === "rug" ? 0.08 : REACHES_OUT.has(item) ? 0.14 : 0.02;
  const ppm = Math.min((width - 4) / (f.w + 2 * pad), (height - 4) / (f.h + 2 * pad));
  return (
    <svg width={width} height={height} viewBox={`${-width / 2} ${-height / 2} ${width} ${height}`} aria-hidden className="fp-preview">
      <FurnitureSymbol item={item} w={f.w * ppm} h={f.h * ppm} ppm={ppm} thin={0.7} />
    </svg>
  );
}
