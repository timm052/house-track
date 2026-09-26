// Furniture drawn from above, the way a floor plan draws it: a bed with its pillows and turned-down cover, a sofa with
// its back, arms and cushions, a dining table with chairs pulled up, a toilet, bath and basin, a car. Each is drawn at
// real size from the plan's scale (pixels per metre), centred on the piece, with its back (a bed's head, a sofa's
// back, a car's bonnet) at the top (-y) before the piece is rotated. Colours come from the piece's room group.
import type { ReactNode } from "react";
import { FURNITURE_BY_KEY, GROUP_COLOUR } from "./furniture";

type Style = { rx?: number; fill?: string; stroke?: string; sw?: number; dash?: string };
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
  return { fill: o.fill ?? "none", stroke: o.stroke ?? k.line, strokeWidth: (o.sw ?? 1) * k.thin, strokeDasharray: o.dash,
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
};
/** Pieces drawn with chairs around them, which reach past the table's own size. */
const WITH_CHAIRS = new Set(["table-4", "table-6", "table-8", "round-table", "outdoor-table"]);

/** A piece of furniture w × h plan pixels, at ppm pixels per metre, centred on the origin. */
export function FurnitureSymbol({ item, w, h, ppm, thin = 1 }: { item: string; w: number; h: number; ppm: number; thin?: number }) {
  const f = FURNITURE_BY_KEY.get(item);
  const base = f ? GROUP_COLOUR[f.group] : "#8a8f93";
  const k: Kit = {
    w, h, m: (metres) => metres * ppm, thin, out: [],
    body: shade(base, 0.78), accent: shade(base, 0.45), dark: shade(base, 0.05), line: shade(base, -0.5),
  };
  (SYMBOLS[item] ?? plain)(k);
  return <g transform={`translate(${-w / 2} ${-h / 2})`}>{k.out}</g>;
}

/** The piece drawn small for the furniture list, fitted to the box. */
export function FurniturePreview({ item, width = 56, height = 40 }: { item: string; width?: number; height?: number }) {
  const f = FURNITURE_BY_KEY.get(item);
  if (!f) return null;
  const pad = WITH_CHAIRS.has(item) ? 0.32 : item === "rug" ? 0.08 : 0.02;
  const ppm = Math.min((width - 4) / (f.w + 2 * pad), (height - 4) / (f.h + 2 * pad));
  return (
    <svg width={width} height={height} viewBox={`${-width / 2} ${-height / 2} ${width} ${height}`} aria-hidden className="fp-preview">
      <FurnitureSymbol item={item} w={f.w * ppm} h={f.h * ppm} ppm={ppm} thin={0.7} />
    </svg>
  );
}
