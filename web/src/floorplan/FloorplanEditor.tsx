// Floor plan markup: set the plan's scale from a length you know, then draw walls and areas, measure, add notes and
// drag in real-size furniture to see how the rooms feel. Each markup is a named version of the plan, saved on the
// server and shared by the household (routes/markup.py). Everything is stored in the plan's own pixel coordinates;
// furniture sizes are in metres, drawn at the plan's scale. Images are used as they are; a PDF plan is drawn from its
// first page.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, ChevronDown, ChevronUp, Copy, DraftingCompass, Eraser, Hand, Magnet, Maximize, MousePointer2, Pencil, Pentagon, Plus,
  Redo2, RotateCcw, RotateCw, Ruler, Save, Slash, Sofa, Square, Trash, Type, Undo2, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, type PropertyDetail } from "../api";
import ConfirmButton from "../ConfirmButton";
import { usePeople } from "../people";
import { FURNITURE, FURNITURE_BY_KEY, GROUP_COLOUR, GROUPS, type FurnitureItem } from "./furniture";
import { FurniturePreview, FurnitureSymbol } from "./symbols";

// ─── the saved shapes ─────────────────────────────────────────────────
type Pt = [number, number];
type Shape =
  | { id: string; type: "line"; points: Pt[]; colour: string }                 // walls and lines
  | { id: string; type: "area"; points: Pt[]; colour: string }                 // a room outline, with its area
  | { id: string; type: "rect"; x: number; y: number; w: number; h: number; colour: string }
  | { id: string; type: "pen"; points: Pt[]; colour: string }
  | { id: string; type: "measure"; a: Pt; b: Pt; colour: string }
  | { id: string; type: "text"; x: number; y: number; text: string; colour: string }
  | { id: string; type: "furniture"; item: string; label: string; x: number; y: number; w: number; h: number; rotation: number };
type Doc = { name: string; px_per_m: number | null; shapes: Shape[] };
type Markup = Doc & { id: string; attachment_id: string; created_at: string; created_by: string; updated_at: string; updated_by: string };
type Tool = "select" | "pan" | "scale" | "measure" | "line" | "area" | "rect" | "pen" | "text" | `furniture:${string}`;

const COLOURS = ["#d9480f", "#1f5a70", "#2b8a3e", "#6741d9", "#212529"];
// Fingers need bigger targets than a mouse: thin lines and corners get a wider invisible hit area on touch screens.
const COARSE = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
const HIT = COARSE ? 30 : 16;
const newId = () => Math.random().toString(36).slice(2, 10);
const dist = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const when = new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/** "3.2", "3.2 m", "3200mm", "320cm", or a bare number of 50 or more (read as millimetres, as plans are dimensioned). */
export function parseLength(text: string): number | null {
  const m = text.trim().toLowerCase().replace(",", ".").match(/^(\d+(?:\.\d+)?)\s*(mm|cm|m)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const metres = m[2] === "mm" ? n / 1000 : m[2] === "cm" ? n / 100 : m[2] === "m" ? n : n >= 50 ? n / 1000 : n;
  return metres > 0 ? metres : null;
}
const metres = (m: number) => `${m < 10 ? m.toFixed(2) : m.toFixed(1)} m`;
function polygonArea(points: Pt[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i], [x2, y2] = points[(i + 1) % points.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}
const centroid = (points: Pt[]): Pt => [points.reduce((s, p) => s + p[0], 0) / points.length, points.reduce((s, p) => s + p[1], 0) / points.length];

// ─── interaction helpers ──────────────────────────────────────────────
/** Where a point snapped to, if anywhere: onto another shape's corner or end ("vertex"), or onto a square or 45°
 *  line from the previous point ("axis", along `deg` through `from`). The guide for either is drawn while it holds. */
type Snap = { p: Pt; kind: "vertex" | "axis" | null; from?: Pt; deg?: number };
/** The pointer as the canvas shows it: snapped point, screen position (for the magnifier), and any note to show. */
type Cursor = { snap: Snap; sx: number; sy: number; touch: boolean; down: boolean; note?: string };
type Drag =
  | { kind: "pan"; x: number; y: number; tx: number; ty: number; samples: { x: number; y: number; t: number }[] }
  | { kind: "move"; id: string; from: Pt; before: Doc; orig: Shape; x: number; y: number; moved: boolean }
  | { kind: "handle"; id: string; handle: string; before: Doc; orig: Shape; x: number; y: number; moved: boolean }
  | { kind: "rect"; from: Pt }
  | { kind: "pen"; points: Pt[] }
  | { kind: "point"; down: Pt; x: number; y: number; moved: boolean; touch: boolean };

/** Tools that place points one tap at a time; the point lands where the pointer comes up. */
const POINT_TOOLS = new Set<Tool>(["scale", "measure", "line", "area"]);
const REDUCED_MOTION = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const clampZoom = (z: number) => Math.min(20, Math.max(0.05, z));

/** Every corner and end the plan's shapes have, to snap to (a few hundred at most, so a scan per move is fine). */
function vertices(shapes: Shape[], skip?: string): Pt[] {
  const out: Pt[] = [];
  for (const s of shapes) {
    if (s.id === skip) continue;
    if (s.type === "line" || s.type === "area") out.push(...s.points);
    else if (s.type === "measure") out.push(s.a, s.b);
    else if (s.type === "rect") out.push([s.x, s.y], [s.x + s.w, s.y], [s.x + s.w, s.y + s.h], [s.x, s.y + s.h]);
  }
  return out;
}

/** easing.standard, cubic-bezier(0.2, 0, 0, 1): x solved for t by Newton's method, then y. */
function standardEase(t: number): number {
  const [x1, y1, x2, y2] = [0.2, 0, 0, 1];
  let u = t;
  for (let i = 0; i < 6; i++) {
    const x = 3 * (1 - u) ** 2 * u * x1 + 3 * (1 - u) * u * u * x2 + u ** 3 - t;
    const dx = 3 * (1 - u) ** 2 * x1 + 6 * (1 - u) * u * (x2 - x1) + 3 * u * u * (1 - x2);
    if (Math.abs(dx) < 1e-6) break;
    u = Math.min(1, Math.max(0, u - x / dx));
  }
  return 3 * (1 - u) ** 2 * u * y1 + 3 * (1 - u) * u * u * y2 + u ** 3;
}

/** A freehand stroke drawn as curves through the midpoints between samples, so it reads as ink, not a polyline. */
function smoothPath(pts: Pt[]): string {
  if (pts.length < 3) return `M${pts.map((p) => p.join(" ")).join(" L")}`;
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i], [nx, ny] = pts[i + 1];
    d += ` Q${x} ${y} ${(x + nx) / 2} ${(y + ny) / 2}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${last[0]} ${last[1]}`;
}

/** Fewer points for a finished stroke (Ramer–Douglas–Peucker): anything within `eps` of the line is dropped. */
function simplify(points: Pt[], eps: number): Pt[] {
  if (points.length < 3) return points;
  const a = points[0], b = points[points.length - 1];
  const l2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
  let index = 0, max = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / l2)) : 0;
    const d = dist(p, [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    if (d > max) { max = d; index = i; }
  }
  if (max <= eps) return [a, b];
  return [...simplify(points.slice(0, index + 1), eps).slice(0, -1), ...simplify(points.slice(index), eps)];
}

function moved(s: Shape, dx: number, dy: number): Shape {
  const shift = (p: Pt): Pt => [p[0] + dx, p[1] + dy];
  switch (s.type) {
    case "line": case "area": case "pen": return { ...s, points: s.points.map(shift) };
    case "measure": return { ...s, a: shift(s.a), b: shift(s.b) };
    default: return { ...s, x: s.x + dx, y: s.y + dy };
  }
}

// ─── the plan as a picture ────────────────────────────────────────────
type Background = { url: string; w: number; h: number };

/** The plan's image and its size in pixels: an image as it is, a PDF's first page drawn at twice its size. */
function usePlanImage(attachmentId: string, mime: string | null | undefined): { bg: Background | null; error: string | null } {
  const [bg, setBg] = useState<Background | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!mime) return;
    let cancelled = false, objectUrl: string | null = null;
    const src = `/api/attachments/${attachmentId}/file`;
    (async () => {
      try {
        if (mime === "application/pdf") {
          const pdfjs = await import("pdfjs-dist");
          const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
          pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
          const doc = await pdfjs.getDocument({ url: src }).promise;
          const page = await doc.getPage(1);
          const viewport = page.getViewport({ scale: 2 });
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(viewport.width);
          canvas.height = Math.round(viewport.height);
          await page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport }).promise;
          const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
          if (!blob || cancelled) return;
          objectUrl = URL.createObjectURL(blob);
          setBg({ url: objectUrl, w: canvas.width, h: canvas.height });
        } else {
          const img = new Image();
          img.onload = () => { if (!cancelled) setBg({ url: src, w: img.naturalWidth, h: img.naturalHeight }); };
          img.onerror = () => { if (!cancelled) setError("Couldn't load the floor plan."); };
          img.src = src;
        }
      } catch (e) {
        if (!cancelled) setError(`Couldn't open the floor plan: ${(e as Error).message}`);
      }
    })();
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [attachmentId, mime]);
  return { bg, error };
}

// ─── the editor ───────────────────────────────────────────────────────
export default function FloorplanEditor() {
  const { id: propertyId = "", attachmentId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { byId } = usePeople();

  const property = useQuery({ queryKey: ["property", propertyId], queryFn: () => api<PropertyDetail>(`/api/properties/${propertyId}`) });
  const attachment = property.data?.attachments.find((a) => a.id === attachmentId);
  const { bg, error: bgError } = usePlanImage(attachmentId, attachment?.mime_type);
  const markups = useQuery({ queryKey: ["markups", attachmentId], queryFn: () => api<Markup[]>(`/api/attachments/${attachmentId}/markups`) });

  // Viewing (the default: look through the saved versions and measure) or editing (?edit=1).
  const editing = params.get("edit") === "1";
  // The version open now: ?v=<id>, else the first saved one, else a new unsaved one.
  const wanted = params.get("v");
  const current = markups.data?.find((m) => m.id === wanted) ?? (wanted === "new" ? null : markups.data?.[0]) ?? null;
  const [doc, setDoc] = useState<Doc>({ name: "Our layout", px_per_m: null, shapes: [] });
  const [base, setBase] = useState<{ id: string | null; updated_at: string | null }>({ id: null, updated_at: null });
  const [past, setPast] = useState<Doc[]>([]);
  const [future, setFuture] = useState<Doc[]>([]);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const loadedKey = useRef<string | null>(null);

  useEffect(() => {
    if (!markups.data) return;
    const key = current ? `${current.id}@${current.updated_at}` : `new:${wanted ?? ""}`;
    if (loadedKey.current === key) return;
    loadedKey.current = key;
    if (current) {
      setDoc({ name: current.name, px_per_m: current.px_per_m, shapes: current.shapes ?? [] });
      setBase({ id: current.id, updated_at: current.updated_at });
    } else {
      // A new version starts from the one it came from (its scale especially), or blank.
      setDoc((d) => ({ name: markups.data.length ? `Version ${markups.data.length + 1}` : "Our layout", px_per_m: d.px_per_m, shapes: wanted === "new" ? d.shapes : [] }));
      setBase({ id: null, updated_at: null });
    }
    setPast([]); setFuture([]); setDirty(false); setSelected(null);
  }, [markups.data, current, wanted, editing]);

  /** A change that can be undone. */
  const commit = useCallback((next: Doc | ((d: Doc) => Doc)) => {
    setDoc((d) => {
      const n = typeof next === "function" ? next(d) : next;
      if (n !== d) { setPast((p) => [...p.slice(-99), d]); setFuture([]); setDirty(true); }
      return n;
    });
  }, []);
  const undo = () => { if (!past.length) return; setFuture((f) => [doc, ...f]); setDoc(past[past.length - 1]); setPast((p) => p.slice(0, -1)); setDirty(true); };
  const redo = () => { if (!future.length) return; setPast((p) => [...p, doc]); setDoc(future[0]); setFuture((f) => f.slice(1)); setDirty(true); };

  // ─── view: zoom and pan ────────────────────────────────────────────
  const wrap = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ k: 1, tx: 0, ty: 0 });
  // The view as of the last render, for gestures and animations that run between renders.
  const viewRef = useRef(view);
  viewRef.current = view;
  const motion = useRef<number | null>(null);   // the running glide or camera move (a requestAnimationFrame id)
  const stopMotion = () => { if (motion.current != null) cancelAnimationFrame(motion.current); motion.current = null; };
  const fitView = useCallback(() => {
    const el = wrap.current;
    if (!el || !bg) return null;
    const z = Math.min(el.clientWidth / bg.w, el.clientHeight / bg.h) * 0.95;
    return { k: z, tx: (el.clientWidth - bg.w * z) / 2, ty: (el.clientHeight - bg.h * z) / 2 };
  }, [bg]);
  /** Move the camera over `ms` (duration.medium 260 ms by default, easing.standard). Zoom eases in log space so it
   *  feels even; any new input stops it where it is. Reduced motion jumps straight there. */
  const animateTo = useCallback((to: { k: number; tx: number; ty: number }, ms = 260) => {
    stopMotion();
    if (REDUCED_MOTION) { setView(to); return; }
    const from = viewRef.current, start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms), e = standardEase(t);
      setView({ k: from.k * (to.k / from.k) ** e, tx: from.tx + (to.tx - from.tx) * e, ty: from.ty + (to.ty - from.ty) * e });
      motion.current = t < 1 ? requestAnimationFrame(step) : null;
    };
    motion.current = requestAnimationFrame(step);
  }, []);
  useEffect(() => { const v = fitView(); if (v) setView(v); }, [fitView]);   // the first fit is instant
  const fit = () => { const v = fitView(); if (v) animateTo(v); };
  // A resize (rotating a phone, the side panel opening) keeps the middle of the view where it was, except just after
  // switching between viewing and editing, when the plan is fitted to its new space.
  const refit = useRef(false);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    let w = el.clientWidth, h = el.clientHeight;
    const ro = new ResizeObserver(() => {
      const nw = el.clientWidth, nh = el.clientHeight;
      if (nw === w && nh === h) return;
      if (refit.current) { refit.current = false; w = nw; h = nh; const v = fitView(); if (v) setView(v); return; }
      setView((v) => ({ ...v, tx: v.tx + (nw - w) / 2, ty: v.ty + (nh - h) / 2 }));
      w = nw; h = nh;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [bg]);
  const toPlan = (clientX: number, clientY: number): Pt => {
    const r = wrap.current!.getBoundingClientRect(), v = viewRef.current;
    return [(clientX - r.left - v.tx) / v.k, (clientY - r.top - v.ty) / v.k];
  };
  /** Zoom by `factor`, keeping the plan under (clientX, clientY) where it is. */
  const zoomAt = (clientX: number, clientY: number, factor: number) => {
    const r = wrap.current!.getBoundingClientRect();
    const cx = clientX - r.left, cy = clientY - r.top;
    setView((v) => {
      const z = clampZoom(v.k * factor);
      return { k: z, tx: cx - (cx - v.tx) * (z / v.k), ty: cy - (cy - v.ty) * (z / v.k) };
    });
  };
  /** Keyboard zoom, about the middle of the view, over duration.short (180 ms). */
  const zoomCentre = (factor: number) => {
    const el = wrap.current;
    if (!el) return;
    const v = viewRef.current, cx = el.clientWidth / 2, cy = el.clientHeight / 2, z = clampZoom(v.k * factor);
    animateTo({ k: z, tx: cx - (cx - v.tx) * (z / v.k), ty: cy - (cy - v.ty) * (z / v.k) }, 180);
  };
  useEffect(() => {  // wheel zoom (passive: false, so the page doesn't scroll)
    const el = wrap.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      stopMotion();
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      // Scrolling zooms, as on a map: about 14% a mouse-wheel notch. A trackpad pinch arrives as ctrl+wheel with small
      // deltas, so it gets a larger factor to keep up with the fingers.
      zoomAt(e.clientX, e.clientY, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  // ─── tools and drawing ─────────────────────────────────────────────
  const [tool, setTool] = useState<Tool>(() => (editing ? "select" : "pan"));
  // Measurements taken while viewing: drawn over the plan, never saved into the version.
  const [temp, setTemp] = useState<Shape[]>([]);
  // On phones the side panel is a sheet over the bottom of the plan, closed until it's wanted.
  const [sheetOpen, setSheetOpen] = useState(false);
  const [colour, setColour] = useState(COLOURS[0]);
  const [snap, setSnap] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Pt[] | null>(null);   // points of the line, area, measure or scale being drawn
  // Where the pointer is, snapped: drives the preview line, the snap guides and (on touch) the magnifier.
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [scalePrompt, setScalePrompt] = useState<{ a: Pt; b: Pt } | null>(null);
  const [textPrompt, setTextPrompt] = useState<{ p: Pt; id?: string } | null>(null);
  const [panning, setPanning] = useState(false);
  const [spaceDown, setSpaceDown] = useState(false);   // hold Space to pan with any tool
  const drag = useRef<Drag | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<null | { d: number; mx: number; my: number }>(null);
  const scaled = doc.px_per_m != null;
  const k = view.k;
  /** n screen pixels in plan units at the current zoom: tolerances are set on screen, so tools behave the same at
   *  any zoom. */
  const px = (n: number) => n / k;
  const SNAP_PX = COARSE ? 16 : 10;

  /** Snap `raw` onto another shape's corner or end (or one of `own`, the corners placed so far), else onto a square
   *  or 45° line from `from`. Off with the magnet switched off, or while Alt is held. */
  function snapPoint(raw: Pt, from: Pt | null, own: Pt[] = [], skip?: string, free = false): Snap {
    if (free || !snap) return { p: raw, kind: null };
    let best: Pt | null = null, bestD = px(SNAP_PX);
    for (const v of [...own, ...vertices(editing ? doc.shapes : [...doc.shapes, ...temp], skip)]) {
      const d = dist(v, raw);
      if (d < bestD) { best = v; bestD = d; }
    }
    if (best) return { p: best, kind: "vertex" };
    if (from && dist(from, raw) > px(8)) {
      const deg = (Math.atan2(raw[1] - from[1], raw[0] - from[0]) * 180) / Math.PI, near = Math.round(deg / 45) * 45;
      if (Math.abs(deg - near) < 6) {
        const r = (near * Math.PI) / 180, ux = Math.cos(r), uy = Math.sin(r);
        const t = (raw[0] - from[0]) * ux + (raw[1] - from[1]) * uy;
        return { p: [from[0] + ux * t, from[1] + uy * t], kind: "axis", from, deg: near };
      }
    }
    return { p: raw, kind: null };
  }

  /** Update the cursor for the current tool: snapped for point tools and boxes, as it is otherwise. */
  function aimAt(e: React.PointerEvent, down: boolean) {
    const p = toPlan(e.clientX, e.clientY), r = wrap.current!.getBoundingClientRect();
    const own = draft ?? [];
    const snapped = POINT_TOOLS.has(tool) ? snapPoint(p, own[own.length - 1] ?? null, own, undefined, e.altKey)
      : tool === "rect" ? snapPoint(p, null, [], undefined, e.altKey) : { p, kind: null };
    setCursor({ snap: snapped, sx: e.clientX - r.left, sy: e.clientY - r.top, touch: e.pointerType === "touch", down });
  }

  /** Call off the gesture in progress (Escape, or a second finger arriving): a moved piece goes back where it was. */
  function cancelGesture() {
    const g = drag.current;
    drag.current = null;
    if (g?.kind === "move" || g?.kind === "handle") setDoc(g.before);
    if (g?.kind === "rect" || g?.kind === "pen") setDraft(null);
    setCursor(null);
    setPanning(false);
  }
  /** A change made by dragging, which updated the doc as it went: one undo step for the whole drag. */
  const remember = (before: Doc) => { setPast((p) => [...p.slice(-99), before]); setFuture([]); setDirty(true); };

  const finishPath = (from: Pt[] | null = draft) => {
    if (!from) return;
    const pts = from.filter((p, i) => i === 0 || dist(p, from[i - 1]) > px(1));   // a double-click taps the last corner twice
    if (tool === "line" && pts.length >= 2) commit((d) => ({ ...d, shapes: [...d.shapes, { id: newId(), type: "line", points: pts, colour }] }));
    if (tool === "area" && pts.length >= 3) commit((d) => ({ ...d, shapes: [...d.shapes, { id: newId(), type: "area", points: pts, colour }] }));
    setDraft(null);
  };
  const chooseTool = (t: Tool) => { setDraft(null); setScalePrompt(null); setTextPrompt(null); setCursor(null); if (t !== "select") setSelected(null); setTool(t); };
  const homeTool: Tool = editing ? "select" : "pan";
  useEffect(() => {   // switching between viewing and editing starts from that mode's usual tool
    chooseTool(editing ? "select" : "pan");
    setSelected(null); setSheetOpen(false); setTemp([]);
    refit.current = true;   // the resize this causes fits the plan; if there's none, fit it after the next frame
    requestAnimationFrame(() => requestAnimationFrame(() => { if (refit.current) { refit.current = false; const v = fitView(); if (v) setView(v); } }));
  }, [editing]);   // eslint-disable-line react-hooks/exhaustive-deps

  /** Add a point where the pointer came up; returns the draft that follows. Tapping the last corner again finishes a
   *  wall or area, as does tapping an area's first corner. */
  function addPoint(q: Pt, cur: Pt[] | null): Pt[] | null {
    const tol = px(SNAP_PX), last = cur?.[cur.length - 1];
    if (cur && last && dist(q, last) < tol) {
      if ((tool === "line" && cur.length >= 2) || (tool === "area" && cur.length >= 3)) { finishPath(cur); return null; }
      return cur;
    }
    if (tool === "area" && cur && cur.length >= 3 && dist(q, cur[0]) < tol) { finishPath(cur); return null; }
    const pts = [...(cur ?? []), q];
    if ((tool === "scale" || tool === "measure") && pts.length === 2) {
      if (tool === "scale") setScalePrompt({ a: pts[0], b: pts[1] });
      else {
        const m: Shape = { id: newId(), type: "measure", a: pts[0], b: pts[1], colour };
        if (editing) commit((d) => ({ ...d, shapes: [...d.shapes, m] })); else setTemp((t) => [...t, m]);
      }
      return null;
    }
    return pts;
  }

  function placeFurniture(item: FurnitureItem, at: Pt) {
    const s: Shape = { id: newId(), type: "furniture", item: item.key, label: item.label, x: at[0], y: at[1], w: item.w, h: item.h, rotation: 0 };
    commit((d) => ({ ...d, shapes: [...d.shapes, s] }));
    setSelected(s.id);
    setTool("select");
    setCursor(null);
  }

  /** The handles a selected shape can be reshaped by: its corners or ends, and a furniture piece's turning handle. */
  function handlesFor(s: Shape): { id: string; p: Pt; rotate?: boolean }[] {
    switch (s.type) {
      case "line": case "area": return s.points.map((p, i) => ({ id: `v${i}`, p }));
      case "measure": return [{ id: "a", p: s.a }, { id: "b", p: s.b }];
      case "rect": return ([[s.x, s.y], [s.x + s.w, s.y], [s.x + s.w, s.y + s.h], [s.x, s.y + s.h]] as Pt[]).map((p, i) => ({ id: `c${i}`, p }));
      case "furniture": {
        if (!scaled) return [];
        const r = (s.rotation * Math.PI) / 180, d = (s.h * doc.px_per_m!) / 2 + px(28);
        return [{ id: "rot", p: [s.x + Math.sin(r) * d, s.y - Math.cos(r) * d], rotate: true }];
      }
      default: return [];
    }
  }

  /** `s` with its handle dragged to `p`: a corner or end moved (snapping as when drawing), a box resized from the
   *  opposite corner, a piece of furniture turned in 15° steps (Alt for any angle). */
  function applyHandle(s: Shape, handle: string, p: Pt, free: boolean): { shape: Shape; snap: Snap; note?: string } {
    if (s.type === "furniture") {
      let deg = (Math.atan2(p[1] - s.y, p[0] - s.x) * 180) / Math.PI + 90;
      if (!free) deg = Math.round(deg / 15) * 15;
      deg = ((deg % 360) + 360) % 360;
      return { shape: { ...s, rotation: deg }, snap: { p, kind: null }, note: `${Math.round(deg)}°` };
    }
    if (s.type === "measure") {
      const sn = snapPoint(p, handle === "a" ? s.b : s.a, [], s.id, free);
      return { shape: handle === "a" ? { ...s, a: sn.p } : { ...s, b: sn.p }, snap: sn, note: scaled ? lengthOf(handle === "a" ? sn.p : s.a, handle === "a" ? s.b : sn.p) : undefined };
    }
    if (s.type === "line" || s.type === "area") {
      const i = Number(handle.slice(1)), n = s.points.length;
      const prev = i > 0 ? s.points[i - 1] : s.type === "area" ? s.points[n - 1] : s.points[1] ?? null;
      const sn = snapPoint(p, prev, s.points.filter((_, j) => j !== i), s.id, free);
      return { shape: { ...s, points: s.points.map((q, j) => (j === i ? sn.p : q)) }, snap: sn };
    }
    if (s.type === "rect") {
      const corners: Pt[] = [[s.x, s.y], [s.x + s.w, s.y], [s.x + s.w, s.y + s.h], [s.x, s.y + s.h]];
      const opp = corners[(Number(handle.slice(1)) + 2) % 4], sn = snapPoint(p, null, [], s.id, free);
      return { shape: { ...s, x: Math.min(opp[0], sn.p[0]), y: Math.min(opp[1], sn.p[1]), w: Math.abs(sn.p[0] - opp[0]), h: Math.abs(sn.p[1] - opp[1]) }, snap: sn };
    }
    return { shape: s, snap: { p, kind: null } };
  }

  /** Let go of a pan while it's moving and the plan glides to a stop: the release speed (over the last 100 ms, capped
   *  at 3 px/ms) decays by 0.5% a millisecond, a little firmer than iOS's 0.2% so a bounded plan doesn't sail away,
   *  and stops under 0.05 px/ms. Any new input catches it. */
  function glide(samples: { x: number; y: number; t: number }[], upAt: number) {
    if (REDUCED_MOTION || samples.length < 2) return;
    const last = samples[samples.length - 1], first = samples[0], dt = last.t - first.t;
    if (dt <= 0 || upAt - last.t > 50) return;   // paused before letting go: no glide
    let vx = (last.x - first.x) / dt, vy = (last.y - first.y) / dt;
    const speed = Math.hypot(vx, vy);
    if (speed < 0.3) return;
    if (speed > 3) { vx *= 3 / speed; vy *= 3 / speed; }
    let prev = performance.now();
    const step = (now: number) => {
      const t = Math.min(32, now - prev);
      prev = now;
      setView((v) => ({ ...v, tx: v.tx + vx * t, ty: v.ty + vy * t }));
      const decay = 0.995 ** t;
      vx *= decay; vy *= decay;
      motion.current = Math.hypot(vx, vy) > 0.05 ? requestAnimationFrame(step) : null;
    };
    stopMotion();
    motion.current = requestAnimationFrame(step);
  }

  function onPointerDown(e: React.PointerEvent) {
    if (!bg) return;
    stopMotion();
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* the pointer's already gone: carry on uncaptured */ }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {   // a second finger: pinch to zoom, whatever the tool; the first one's gesture is off
      cancelGesture();
      const [a, b] = [...pointers.current.values()];
      pinch.current = { d: Math.hypot(b.x - a.x, b.y - a.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      return;
    }
    if (pointers.current.size > 2) return;
    const p = toPlan(e.clientX, e.clientY);
    const target = e.target as Element;
    const handle = target.closest?.("[data-handle]")?.getAttribute("data-handle") ?? null;
    const shapeId = target.closest?.("[data-shape]")?.getAttribute("data-shape") ?? null;
    if (tool === "pan" || spaceDown || e.button === 1 || (tool === "select" && !shapeId && !handle)) {
      if (tool === "select" && !spaceDown && e.button !== 1) setSelected(null);
      drag.current = { kind: "pan", x: e.clientX, y: e.clientY, tx: viewRef.current.tx, ty: viewRef.current.ty, samples: [{ x: e.clientX, y: e.clientY, t: e.timeStamp }] };
      setPanning(true);
      return;
    }
    if (tool === "select" && handle && selectedShape) {
      drag.current = { kind: "handle", id: selectedShape.id, handle, before: doc, orig: selectedShape, x: e.clientX, y: e.clientY, moved: false };
      return;
    }
    if (tool === "select" && shapeId) {
      const orig = doc.shapes.find((s) => s.id === shapeId);
      if (!orig) return;
      setSelected(shapeId);
      drag.current = { kind: "move", id: shapeId, from: p, before: doc, orig, x: e.clientX, y: e.clientY, moved: false };
      return;
    }
    if (tool.startsWith("furniture:")) {
      const item = FURNITURE_BY_KEY.get(tool.slice(10));
      if (item) placeFurniture(item, p);
      return;
    }
    if (tool === "text") { setTextPrompt({ p }); return; }
    if (tool === "pen") { drag.current = { kind: "pen", points: [p] }; setDraft([p]); return; }
    if (tool === "rect") {
      const a = snapPoint(p, null, [], undefined, e.altKey).p;
      drag.current = { kind: "rect", from: a };
      setDraft([a, a]);
      aimAt(e, true);
      return;
    }
    // Scale, measure, wall and area: the point goes where the pointer comes up, so a finger can slide to aim (with the
    // magnifier showing what it covers) and a mouse can press at one end of a dimension and release at the other.
    drag.current = { kind: "point", down: p, x: e.clientX, y: e.clientY, moved: false, touch: e.pointerType === "touch" };
    aimAt(e, true);
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!bg) return;
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current) {
      if (pointers.current.size !== 2) return;
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(b.x - a.x, b.y - a.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, last = pinch.current;
      pinch.current = { d, mx, my };
      const r = wrap.current!.getBoundingClientRect(), cx = mx - r.left, cy = my - r.top;
      setView((v) => {   // move with the fingers' midpoint and scale about it, in one step
        const z = clampZoom(v.k * (d / last.d)), tx = v.tx + (mx - last.mx), ty = v.ty + (my - last.my);
        return { k: z, tx: cx - (cx - tx) * (z / v.k), ty: cy - (cy - ty) * (z / v.k) };
      });
      return;
    }
    const g = drag.current;
    if (!g) {   // hovering: preview what a click would do (fine pointers only; a finger doesn't hover)
      if (e.pointerType !== "touch" && tool !== "select" && tool !== "pan") aimAt(e, false);
      return;
    }
    const p = toPlan(e.clientX, e.clientY);
    const slop = e.pointerType === "touch" ? 8 : 4;   // screen px before a press becomes a drag
    switch (g.kind) {
      case "pan":
        setView((v) => ({ ...v, tx: g.tx + e.clientX - g.x, ty: g.ty + e.clientY - g.y }));
        g.samples.push({ x: e.clientX, y: e.clientY, t: e.timeStamp });
        while (g.samples.length > 2 && e.timeStamp - g.samples[0].t > 100) g.samples.shift();
        return;
      case "move": {
        if (!g.moved && Math.hypot(e.clientX - g.x, e.clientY - g.y) < slop) return;
        g.moved = true;
        const dx = p[0] - g.from[0], dy = p[1] - g.from[1];
        setDoc((d) => ({ ...d, shapes: d.shapes.map((s) => (s.id === g.id ? moved(g.orig, dx, dy) : s)) }));
        return;
      }
      case "handle": {
        if (!g.moved && Math.hypot(e.clientX - g.x, e.clientY - g.y) < slop) return;
        g.moved = true;
        const { shape, snap: sn, note } = applyHandle(g.orig, g.handle, p, e.altKey);
        setDoc((d) => ({ ...d, shapes: d.shapes.map((s) => (s.id === g.id ? shape : s)) }));
        const r = wrap.current!.getBoundingClientRect();
        setCursor({ snap: sn, sx: e.clientX - r.left, sy: e.clientY - r.top, touch: e.pointerType === "touch", down: true, note });
        return;
      }
      case "rect":
        setDraft([g.from, snapPoint(p, null, [], undefined, e.altKey).p]);
        aimAt(e, true);
        return;
      case "pen": {
        // Every sample the pointer gave since the last event (a fast stroke delivers several a frame), for smooth ink.
        const samples = e.nativeEvent.getCoalescedEvents?.() ?? [];
        for (const ev of samples.length ? samples : [e.nativeEvent]) {
          const q = toPlan(ev.clientX, ev.clientY);
          if (dist(g.points[g.points.length - 1], q) > px(1.5)) g.points.push(q);
        }
        setDraft([...g.points]);
        return;
      }
      case "point":
        if (!g.moved && Math.hypot(e.clientX - g.x, e.clientY - g.y) >= slop) g.moved = true;
        aimAt(e, true);
        return;
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    if (pinch.current) { if (pointers.current.size < 2) pinch.current = null; return; }   // the end of a pinch does nothing else
    const g = drag.current;
    drag.current = null;
    if (!g) return;
    const cancelled = e.type === "pointercancel";
    switch (g.kind) {
      case "pan":
        setPanning(false);
        if (!cancelled) glide(g.samples, e.timeStamp);
        return;
      case "move":
        if (g.moved) remember(g.before);
        return;
      case "handle":
        if (g.moved) remember(g.before);
        setCursor(null);
        return;
      case "rect": {
        const [a, b] = draft ?? [g.from, g.from];
        if (!cancelled && Math.abs(b[0] - a[0]) > px(4) && Math.abs(b[1] - a[1]) > px(4)) {
          commit((d) => ({ ...d, shapes: [...d.shapes, { id: newId(), type: "rect", x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]),
            w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]), colour }] }));
        }
        setDraft(null);
        if (e.pointerType === "touch") setCursor(null);
        return;
      }
      case "pen":
        if (!cancelled && g.points.length > 1) {
          const points = simplify(g.points, px(0.75));
          commit((d) => ({ ...d, shapes: [...d.shapes, { id: newId(), type: "pen", points, colour }] }));
        }
        setDraft(null);
        return;
      case "point": {
        if (cancelled) { setCursor(null); return; }
        let cur = draft;
        if (!g.touch && g.moved && (tool === "measure" || tool === "scale") && !cur?.length) {
          cur = addPoint(snapPoint(g.down, null, [], undefined, e.altKey).p, cur);   // pressed at one end, released at the other
        }
        const p = toPlan(e.clientX, e.clientY);
        cur = addPoint(snapPoint(p, cur?.[cur.length - 1] ?? null, cur ?? [], undefined, e.altKey).p, cur);
        setDraft(cur);
        if (g.touch) setCursor(null);
        else setCursor((c) => (c ? { ...c, down: false } : c));
        return;
      }
    }
  }

  // Drag furniture from the palette onto the plan (desktop); a tap on a piece then a tap on the plan works everywhere.
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const item = FURNITURE_BY_KEY.get(e.dataTransfer.getData("text/x-furniture"));
    if (item && scaled && bg) placeFurniture(item, toPlan(e.clientX, e.clientY));
  }

  const selectedShape = doc.shapes.find((s) => s.id === selected) ?? null;
  const update = (id: string, change: (s: Shape) => Shape) => commit((d) => ({ ...d, shapes: d.shapes.map((s) => (s.id === id ? change(s) : s)) }));
  const remove = (id: string) => { commit((d) => ({ ...d, shapes: d.shapes.filter((s) => s.id !== id) })); setSelected(null); };
  const duplicate = (s: Shape) => {
    const copy = { ...moved(s, 20 / k, 20 / k), id: newId() } as Shape;
    commit((d) => ({ ...d, shapes: [...d.shapes, copy] }));
    setSelected(copy.id);
  };

  // Keyboard: Space-drag to pan, Escape to call off, Ctrl+Z (a corner at a time while drawing), Delete, arrows to nudge,
  // R to turn furniture, + / - / 0 to zoom and fit.
  useEffect(() => {
    const NUDGE: Record<string, Pt> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest?.("input, textarea, select")) return;
      if (e.key === " ") {
        e.preventDefault();
        (document.activeElement as HTMLElement | null)?.blur?.();   // so Space doesn't also press the focused button
        if (!e.repeat) setSpaceDown(true);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (!e.shiftKey && draft?.length && POINT_TOOLS.has(tool)) { setDraft(draft.length > 1 ? draft.slice(0, -1) : null); return; }
        if (!editing) { if (!e.shiftKey) setTemp((t) => t.slice(0, -1)); return; }   // viewing: take back the last measurement
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); if (editing) redo(); return; }
      if (e.key === "Escape") {
        if (drag.current) { cancelGesture(); return; }   // the piece goes back where it was
        if (scalePrompt || textPrompt) { setScalePrompt(null); setTextPrompt(null); return; }
        if (draft) { setDraft(null); return; }
        if (tool !== homeTool) { chooseTool(homeTool); return; }
        setSelected(null);
        return;
      }
      if (e.key === "Enter" && draft) { finishPath(); return; }
      if ((e.key === "Delete" || e.key === "Backspace") && selected) { e.preventDefault(); remove(selected); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "+" || e.key === "=") { zoomCentre(1.25); return; }
      if (e.key === "-" || e.key === "_") { zoomCentre(0.8); return; }
      if (e.key === "0") { fit(); return; }
      if (selectedShape && NUDGE[e.key]) {   // a screen pixel at a time, ten with Shift
        e.preventDefault();
        const [dx, dy] = NUDGE[e.key], step = px(e.shiftKey ? 10 : 1);
        update(selectedShape.id, (s) => moved(s, dx * step, dy * step));
        return;
      }
      if (e.key.toLowerCase() === "r" && selectedShape?.type === "furniture") {
        update(selectedShape.id, (s) => (s.type === "furniture" ? { ...s, rotation: (s.rotation + (e.shiftKey ? 15 : 90)) % 360 } : s));
      }
    };
    const onKeyUp = (e: KeyboardEvent) => { if (e.key === " ") setSpaceDown(false); };
    const onBlur = () => setSpaceDown(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("keyup", onKeyUp); window.removeEventListener("blur", onBlur); };
  });

  // Leaving with unsaved changes asks first.
  useEffect(() => {
    const onLeave = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [dirty]);

  // ─── saving versions ───────────────────────────────────────────────
  /** Open version `v` (none: the first saved one), viewing or editing. */
  const go = (v: string | null, edit: boolean, replace = false) =>
    setParams({ ...(v ? { v } : {}), ...(edit ? { edit: "1" } : {}) }, { replace });
  const startEditing = () => go(base.id, true);
  const stopEditing = () => {
    if (dirty && !window.confirm("Discard your unsaved changes?")) return;
    loadedKey.current = null;   // back to the version as saved
    go(base.id, false);
  };
  const [saving, setSaving] = useState(false);
  async function save(asNew: boolean) {
    setSaving(true); setMsg(null);
    try {
      const body = { name: doc.name.trim() || "Untitled", px_per_m: doc.px_per_m, shapes: doc.shapes };
      const saved = asNew || !base.id
        ? await api<Markup>(`/api/attachments/${attachmentId}/markups`, { method: "POST", body: asNew ? { ...body, name: `${body.name} (copy)` } : body })
        : await api<Markup>(`/api/markups/${base.id}`, { method: "PUT", body: { ...body, expected_updated_at: base.updated_at } });
      loadedKey.current = `${saved.id}@${saved.updated_at}`;
      setBase({ id: saved.id, updated_at: saved.updated_at });
      setDoc((d) => ({ ...d, name: saved.name }));
      setDirty(false);
      go(saved.id, true, true);
      await queryClient.invalidateQueries({ queryKey: ["markups", attachmentId] });
      queryClient.invalidateQueries({ queryKey: ["property", propertyId] });
      setMsg({ text: asNew ? `Saved as a new version, "${saved.name}".` : "Saved." });
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    } finally {
      setSaving(false);
    }
  }
  async function deleteVersion() {
    if (!base.id) return;
    await api(`/api/markups/${base.id}`, { method: "DELETE" });
    loadedKey.current = null;
    go(null, true, true);
    await queryClient.invalidateQueries({ queryKey: ["markups", attachmentId] });
    queryClient.invalidateQueries({ queryKey: ["property", propertyId] });
  }
  const switchVersion = (v: string) => {
    if (dirty && !window.confirm("Discard your unsaved changes?")) return;
    loadedKey.current = null;
    go(v, editing);
  };

  // ─── drawing the shapes ────────────────────────────────────────────
  const fontSize = 13 / k, stroke = 2;
  const label = (x: number, y: number, text: string, fill = "#111") => (
    <text x={x} y={y} fontSize={fontSize} textAnchor="middle" dominantBaseline="middle" className="fp-label" fill={fill}
      stroke="#fff" strokeWidth={3 / k} paintOrder="stroke">{text}</text>
  );
  const lengthOf = (a: Pt, b: Pt) => (scaled ? metres(dist(a, b) / doc.px_per_m!) : "");

  function drawShape(s: Shape) {
    const isSel = s.id === selected;
    const common = { "data-shape": s.id, className: `fp-shape ${isSel ? "sel" : ""}` };
    switch (s.type) {
      case "line": case "pen": {
        const pts = s.points.map((p) => p.join(",")).join(" ");
        return (
          <g key={s.id} {...common}>
            <polyline points={pts} fill="none" stroke="transparent" strokeWidth={HIT} vectorEffect="non-scaling-stroke" />
            {s.type === "pen"
              ? <path d={smoothPath(s.points)} fill="none" stroke={s.colour} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke" />
              : <polyline points={pts} fill="none" stroke={s.colour} strokeWidth={stroke + 1.5} strokeLinecap="round" strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke" />}
            {s.type === "line" && scaled && s.points.slice(1).map((p, i) => {
              const a = s.points[i];
              return <g key={i}>{label((a[0] + p[0]) / 2, (a[1] + p[1]) / 2 - 10 / k, lengthOf(a, p), s.colour)}</g>;
            })}
          </g>
        );
      }
      case "area": {
        const [cx, cy] = centroid(s.points);
        const m2 = scaled ? polygonArea(s.points) / doc.px_per_m! ** 2 : null;
        return (
          <g key={s.id} {...common}>
            <polygon points={s.points.map((p) => p.join(",")).join(" ")} fill={s.colour} fillOpacity={0.12} stroke={s.colour}
              strokeWidth={stroke} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
            {m2 != null && label(cx, cy, `${m2.toFixed(1)} m²`, s.colour)}
          </g>
        );
      }
      case "rect": {
        const size = scaled ? `${metres(s.w / doc.px_per_m!)} × ${metres(s.h / doc.px_per_m!)}` : "";
        return (
          <g key={s.id} {...common}>
            <rect x={s.x} y={s.y} width={s.w} height={s.h} fill={s.colour} fillOpacity={0.1} stroke={s.colour} strokeWidth={stroke}
              vectorEffect="non-scaling-stroke" />
            {scaled && label(s.x + s.w / 2, s.y + s.h / 2, `${size} · ${((s.w * s.h) / doc.px_per_m! ** 2).toFixed(1)} m²`, s.colour)}
          </g>
        );
      }
      case "measure": {
        const ang = Math.atan2(s.b[1] - s.a[1], s.b[0] - s.a[0]), t = 6 / k;
        const tick = (p: Pt) => <line x1={p[0] - Math.sin(ang) * t} y1={p[1] + Math.cos(ang) * t} x2={p[0] + Math.sin(ang) * t}
          y2={p[1] - Math.cos(ang) * t} stroke={s.colour} strokeWidth={stroke} vectorEffect="non-scaling-stroke" />;
        return (
          <g key={s.id} {...common}>
            <line x1={s.a[0]} y1={s.a[1]} x2={s.b[0]} y2={s.b[1]} stroke="transparent" strokeWidth={HIT} vectorEffect="non-scaling-stroke" />
            <line x1={s.a[0]} y1={s.a[1]} x2={s.b[0]} y2={s.b[1]} stroke={s.colour} strokeWidth={stroke} vectorEffect="non-scaling-stroke" />
            {tick(s.a)}{tick(s.b)}
            {label((s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2 - 10 / k, scaled ? lengthOf(s.a, s.b) : "set the scale", s.colour)}
          </g>
        );
      }
      case "text":
        return (
          <g key={s.id} {...common}>
            <text x={s.x} y={s.y} fontSize={fontSize * 1.2} fill={s.colour} fontWeight={600} stroke="#fff" strokeWidth={3 / k}
              paintOrder="stroke">{s.text}</text>
          </g>
        );
      case "furniture": {
        if (!scaled) return null;
        const item = FURNITURE_BY_KEY.get(s.item);
        const ppm = doc.px_per_m!, w = s.w * ppm, h = s.h * ppm;
        // The drawing says what it is; the name and size show when it's selected, or when it's been renamed.
        const showText = isSel || !item || s.label !== item.label;
        return (
          <g key={s.id} {...common} transform={`translate(${s.x} ${s.y}) rotate(${s.rotation})`}>
            <rect x={-w / 2} y={-h / 2} width={w} height={h} fill="transparent" />
            <FurnitureSymbol item={s.item} w={w} h={h} ppm={ppm} />
            {showText && (
              <g transform={`rotate(${-s.rotation})`}>
                {label(0, -fontSize * 0.6, s.label)}
                {label(0, fontSize * 0.6, `${s.w.toFixed(2)} × ${s.h.toFixed(2)} m${item?.tall ? `, ${item.tall.toFixed(2)} tall` : ""}`, "#333")}
              </g>
            )}
          </g>
        );
      }
    }
  }

  function drawDraft() {
    if (!draft) return null;
    const aim = cursor?.snap.p;
    const pts = tool === "rect" || tool === "pen" ? draft : aim ? [...draft, aim] : draft;
    if (tool === "rect" && pts.length === 2) {
      const [a, b] = pts;
      const w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
      return (
        <g pointerEvents="none">
          <rect x={Math.min(a[0], b[0])} y={Math.min(a[1], b[1])} width={w} height={h} fill={colour} fillOpacity={0.1} stroke={colour}
            strokeWidth={stroke} vectorEffect="non-scaling-stroke" />
          {scaled && label(Math.min(a[0], b[0]) + w / 2, Math.min(a[1], b[1]) + h / 2, `${metres(w / doc.px_per_m!)} × ${metres(h / doc.px_per_m!)}`, colour)}
        </g>
      );
    }
    if (tool === "pen") {
      return <path d={smoothPath(pts)} fill="none" stroke={colour} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round"
        vectorEffect="non-scaling-stroke" pointerEvents="none" />;
    }
    const line = pts.map((p) => p.join(",")).join(" ");
    // Each segment's length as it's drawn, the one following the pointer included (not while it has no length).
    const segments = pts.slice(1).map((b, i) => [pts[i], b] as [Pt, Pt]).filter(([a, b]) => dist(a, b) > px(6));
    const tint = tool === "scale" ? "#e8590c" : colour;
    return (
      <g pointerEvents="none">
        {tool === "area" && pts.length >= 3
          ? <polygon points={line} fill={tint} fillOpacity={0.1} stroke={tint} strokeWidth={stroke} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
          : <polyline points={line} fill="none" stroke={tint} strokeWidth={stroke} strokeDasharray={tool === "scale" ? "5 4" : undefined} vectorEffect="non-scaling-stroke" />}
        {draft.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={px(i === 0 && tool === "area" ? 5.5 : 4)} fill="#fff" stroke={tint} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />)}
        {scaled && tool !== "scale" && segments.map(([a, b], i) => <g key={i}>{label((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - px(10), lengthOf(a, b), tint)}</g>)}
      </g>
    );
  }

  /** On top of the plan: snap guides, where a click will land, a preview of furniture about to be placed, the
   *  selected shape's handles, and a note while dragging (an angle or a length). */
  function drawOverlay() {
    const guide = cursor?.snap, accent = "#1c7ed6";
    const sel = tool === "select" ? selectedShape : null;
    const item = tool.startsWith("furniture:") ? FURNITURE_BY_KEY.get(tool.slice(10)) : null;
    return (
      <g>
        {guide?.kind === "axis" && guide.from && guide.deg != null && (() => {
          const r = (guide.deg * Math.PI) / 180, L = px(5000), [fx, fy] = guide.from;
          return <line x1={fx - Math.cos(r) * L} y1={fy - Math.sin(r) * L} x2={fx + Math.cos(r) * L} y2={fy + Math.sin(r) * L}
            stroke={accent} strokeWidth={1} strokeDasharray="5 5" opacity={0.75} vectorEffect="non-scaling-stroke" pointerEvents="none" />;
        })()}
        {guide?.kind === "vertex" && <circle cx={guide.p[0]} cy={guide.p[1]} r={px(9)} fill="none" stroke={accent} strokeWidth={2}
          vectorEffect="non-scaling-stroke" pointerEvents="none" />}
        {cursor && !cursor.touch && POINT_TOOLS.has(tool) && <circle cx={cursor.snap.p[0]} cy={cursor.snap.p[1]} r={px(3)} fill={accent} pointerEvents="none" />}
        {item && scaled && cursor && !cursor.touch && (
          <g transform={`translate(${cursor.snap.p[0]} ${cursor.snap.p[1]})`} opacity={0.55} pointerEvents="none">
            <FurnitureSymbol item={item.key} w={item.w * doc.px_per_m!} h={item.h * doc.px_per_m!} ppm={doc.px_per_m!} />
          </g>
        )}
        {sel && handlesFor(sel).map((h) => (
          <g key={h.id} data-handle={h.id} className={`fp-handle ${h.rotate ? "rotate" : ""}`}>
            {h.rotate && sel.type === "furniture" && <line x1={sel.x} y1={sel.y} x2={h.p[0]} y2={h.p[1]} stroke={accent} strokeWidth={1}
              strokeDasharray="3 3" vectorEffect="non-scaling-stroke" pointerEvents="none" />}
            <circle cx={h.p[0]} cy={h.p[1]} r={px(COARSE ? 22 : 10)} fill="transparent" />
            <circle className="fp-handle-dot" cx={h.p[0]} cy={h.p[1]} r={px(h.rotate ? 6.5 : 5.5)} fill={h.rotate ? accent : "#fff"} stroke={accent}
              strokeWidth={2} vectorEffect="non-scaling-stroke" />
          </g>
        ))}
        {cursor?.note && label(cursor.snap.p[0], cursor.snap.p[1] - px(24), cursor.note, accent)}
      </g>
    );
  }

  // The shapes drawn once per change or zoom, not on every pan frame.
  // Room areas and boxes go underneath, so furniture and walls drawn in them stay visible.
  const shapesLayer = useMemo(() => [...doc.shapes].sort((a, b) => Number(a.type !== "area" && a.type !== "rect") - Number(b.type !== "area" && b.type !== "rect"))
    .map(drawShape), [doc.shapes, doc.px_per_m, k, selected]);   // eslint-disable-line react-hooks/exhaustive-deps

  /** On touch, a magnifier above the finger while aiming, since the finger hides the very spot being placed. */
  function drawLoupe() {
    const aiming = drag.current?.kind === "point" || drag.current?.kind === "rect" || drag.current?.kind === "handle";
    if (!bg || !cursor?.touch || !cursor.down || !aiming || !wrap.current) return null;
    const size = 124, zoom = 2.5, half = size / 2 / (k * zoom), [x, y] = cursor.snap.p;
    let left = cursor.sx - size / 2, top = cursor.sy - size - 56;
    if (top < 8) top = cursor.sy + 56;
    left = Math.max(8, Math.min(wrap.current.clientWidth - size - 8, left));
    return (
      <div className="fp-loupe" style={{ left, top, width: size, height: size }} aria-hidden>
        <svg width={size} height={size} viewBox={`${x - half} ${y - half} ${half * 2} ${half * 2}`}>
          <image href={bg.url} width={bg.w} height={bg.h} />
          {shapesLayer}
          {drawDraft()}
          <line x1={x - half} y1={y} x2={x + half} y2={y} stroke="#1c7ed6" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          <line x1={x} y1={y - half} x2={x} y2={y + half} stroke="#1c7ed6" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        </svg>
      </div>
    );
  }
  const author = current ? byId.get(current.updated_by)?.display_name : null;
  const needsScale = editing && !scaled && (tool.startsWith("furniture:") || tool === "measure");
  const versions = markups.data ?? [];

  if (property.isError) return <p className="error">Couldn't load the house.</p>;
  if (property.data && !attachment) return <p>That floor plan isn't on this house any more. <Link to={`/p/${propertyId}`}>Back to the house</Link></p>;

  const TOOLS: { t: Tool; icon: React.ReactNode; label: string; title: string }[] = [
    { t: "select", icon: <MousePointer2 />, label: "Select", title: "Select and move things" },
    { t: "pan", icon: <Hand />, label: "Pan", title: "Move around the plan. Or hold Space with any tool." },
    { t: "scale", icon: <DraftingCompass />, label: "Scale", title: "Click both ends of a length you know" },
    { t: "measure", icon: <Ruler />, label: "Measure", title: "Click both ends, or drag from one to the other" },
    { t: "line", icon: <Slash />, label: "Wall", title: "Click each corner. Click the last one again to finish." },
    { t: "area", icon: <Pentagon />, label: "Area", title: "Click each corner. Click the first one to close." },
    { t: "rect", icon: <Square />, label: "Box", title: "Drag to draw a box" },
    { t: "pen", icon: <Pencil />, label: "Pen", title: "Draw freehand" },
    { t: "text", icon: <Type />, label: "Note", title: "Click where the note goes" },
  ];

  return (
    <div className="fp-page">
      {!editing && (
        <>
          <div className="fp-bar">
            <button className="link" onClick={() => navigate(`/p/${propertyId}`)} title="Back to the house"><ArrowLeft /></button>
            <div className="fp-tools" role="toolbar" aria-label="Tools">
              <button className={tool === "pan" ? "on" : ""} aria-pressed={tool === "pan"} title="Move around the plan" onClick={() => chooseTool("pan")}>
                <Hand /><span className="fp-tool-label">Move</span></button>
              <button className={tool === "measure" ? "on" : ""} aria-pressed={tool === "measure"} disabled={!scaled}
                title={scaled ? "Click both ends of what you want to measure" : "Set the scale in Edit to measure"} onClick={() => chooseTool("measure")}>
                <Ruler /><span className="fp-tool-label">Measure</span></button>
              <button disabled={!temp.length} title="Clear measurements" onClick={() => { setTemp([]); setDraft(null); }}>
                <Eraser /><span className="fp-tool-label">Clear</span></button>
              <button title="Fit to screen (0)" onClick={fit}><Maximize /><span className="fp-tool-label">Fit</span></button>
            </div>
          </div>
          <div className="fp-versions" role="tablist" aria-label="Saved versions">
            {versions.length === 0 && <span className="small muted">No marked-up versions yet</span>}
            {versions.map((m) => (
              <button key={m.id} role="tab" aria-selected={m.id === base.id} className={`fp-chip ${m.id === base.id ? "on" : ""}`}
                onClick={() => switchVersion(m.id)}>{m.name}</button>
            ))}
            {current && <span className="tiny muted fp-versions-by">Saved by {author ?? "someone"}, {when.format(new Date(current.updated_at))}</span>}
          </div>
        </>
      )}
      {editing && <div className="fp-bar">
        <button className="link" onClick={stopEditing} title="Done editing"><ArrowLeft /><span className="fp-tool-label">Done</span></button>
        <div className="fp-tools" role="toolbar" aria-label="Tools">
          {TOOLS.map(({ t, icon, label: l, title }) => (
            <button key={t} className={tool === t ? "on" : ""} aria-pressed={tool === t} title={title} onClick={() => chooseTool(t)}>
              {icon}<span className="fp-tool-label">{l}</span></button>
          ))}
        </div>
        <div className="fp-tools">
          <button className={snap ? "on" : ""} aria-pressed={snap} title="Snap to corners, straight lines and 45°. Hold Alt to turn it off."
            onClick={() => setSnap(!snap)}><Magnet /></button>
          <button disabled={!past.length} title="Undo (Ctrl+Z)" onClick={undo}><Undo2 /></button>
          <button disabled={!future.length} title="Redo (Ctrl+Shift+Z)" onClick={redo}><Redo2 /></button>
          <button title="Fit to screen (0)" onClick={fit}><Maximize /></button>
        </div>
        {dirty && <button className="primary small-btn fp-quicksave" disabled={saving} onClick={() => save(false)} title="Save this version"><Save /> Save</button>}
        <div className="fp-colours" aria-label="Colour">
          {COLOURS.map((c) => <button key={c} className={colour === c ? "on" : ""} style={{ background: c }} aria-label={`Colour ${c}`}
            onClick={() => { setColour(c); if (selectedShape && "colour" in selectedShape) update(selectedShape.id, (s) => ({ ...s, colour: c }) as Shape); }} />)}
        </div>
      </div>}

      <div className="fp-main">
        <div ref={wrap} className={`fp-canvas tool-${tool.split(":")[0]} ${panning ? "panning" : ""} ${spaceDown ? "space" : ""}`}
          onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          {bgError && <p className="error" style={{ padding: 16 }}>{bgError}</p>}
          {!bg && !bgError && <p className="muted" style={{ padding: 16 }}>Loading the floor plan…</p>}
          {bg && (
            <svg width="100%" height="100%" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp} onPointerLeave={(e) => { if (!drag.current && e.pointerType !== "touch") setCursor(null); }}
              onDoubleClick={() => finishPath()} style={{ touchAction: "none" }}>
              <g transform={`translate(${view.tx} ${view.ty}) scale(${k})`}>
                <image href={bg.url} width={bg.w} height={bg.h} />
                {shapesLayer}
                {!editing && temp.map(drawShape)}
                {drawDraft()}
                {drawOverlay()}
              </g>
            </svg>
          )}
          {drawLoupe()}
          {!editing && bg && markups.isSuccess && (versions.length === 0 || !scaled) && (
            <div className="fp-hint top">{versions.length === 0
              ? <>Nobody has marked up this plan yet. Press <strong>Edit</strong> to set its scale, measure rooms and try furniture.</>
              : <>This version has no scale yet, so it can't be measured. Press <strong>Edit</strong> to set it.</>}</div>
          )}
          {!editing && tool === "measure" && !draft && temp.length === 0 && (
            <div className="fp-float"><span className="small">{COARSE ? "Tap" : "Click"} both ends to measure. Measurements aren't saved.</span></div>
          )}
          {!editing && bg && (
            <button className="primary fp-edit" onClick={startEditing}><Pencil /> {versions.length ? "Edit" : "Mark up"}</button>
          )}
          {editing && (needsScale || (!scaled && tool === "select" && doc.shapes.length === 0)) && (
            <div className="fp-hint">Set the scale first. Choose <strong>Scale</strong>, tap both ends of a length printed on the plan, then
              enter that length. Furniture and measurements will then be true to size.</div>
          )}
          {tool.startsWith("furniture:") && scaled && (
            <div className="fp-float">
              <span className="small">{COARSE ? "Tap" : "Click"} where the {FURNITURE_BY_KEY.get(tool.slice(10))?.label.toLowerCase()} goes</span>
              <button className="small-btn" onClick={() => chooseTool("select")} aria-label="Cancel"><X /></button>
            </div>
          )}
          {selectedShape && tool === "select" && (
            <div className="fp-selbar" role="toolbar" aria-label="Selected item">
              {selectedShape.type === "furniture" && <>
                <span className="small fp-selname">{selectedShape.label}</span>
                <button title="Rotate 90°" onClick={() => update(selectedShape.id, (s) => (s.type === "furniture" ? { ...s, rotation: (s.rotation + 90) % 360 } : s))}><RotateCw /> 90°</button>
                <button title="Rotate 15°" onClick={() => update(selectedShape.id, (s) => (s.type === "furniture" ? { ...s, rotation: (s.rotation + 15) % 360 } : s))}><RotateCw /> 15°</button>
              </>}
              <button title="Duplicate" onClick={() => duplicate(selectedShape)}><Copy /></button>
              <button title="Edit details" onClick={() => setSheetOpen(true)} className="fp-mobile-only">Edit</button>
              <button title="Delete" className="danger" onClick={() => remove(selectedShape.id)}><Trash /></button>
            </div>
          )}
          {draft && (tool === "line" || tool === "area") && (
            <div className="fp-float">
              <span className="small fp-float-hint">{COARSE ? "Tap" : "Click"} the last corner again, or</span>
              <button className="primary small-btn" onClick={() => finishPath()}>Finish</button>
              <button className="small-btn" onClick={() => setDraft(null)}>Cancel</button>
            </div>
          )}
          {scalePrompt && (
            <ScaleDialog pixels={dist(scalePrompt.a, scalePrompt.b)} onCancel={() => setScalePrompt(null)}
              onSet={(m) => { commit((d) => ({ ...d, px_per_m: dist(scalePrompt.a, scalePrompt.b) / m })); setScalePrompt(null); setTool("select"); }} />
          )}
          {textPrompt && (
            <TextDialog initial="" onCancel={() => setTextPrompt(null)} onSet={(text) => {
              commit((d) => ({ ...d, shapes: [...d.shapes, { id: newId(), type: "text", x: textPrompt.p[0], y: textPrompt.p[1], text, colour }] }));
              setTextPrompt(null);
            }} />
          )}
        </div>

        {editing && !sheetOpen && (
          <button className="fp-sheet-toggle" onClick={() => setSheetOpen(true)} aria-expanded={false}>
            <ChevronUp />{doc.name}{dirty ? " · unsaved" : ""} · Furniture
          </button>
        )}
        {editing && <aside className={`fp-side ${sheetOpen ? "open" : ""}`}>
          <button className="fp-sheet-close" onClick={() => setSheetOpen(false)} aria-label="Close the panel"><ChevronDown /> Close</button>
          <section>
            <div className="section-title">Version</div>
            <div className="row">
              <select className="grow" value={base.id ?? "new"} onChange={(e) => switchVersion(e.target.value)}>
                {(markups.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                {!base.id && <option value="new">{doc.name} (not saved)</option>}
              </select>
              <button className="small-btn" title="New version, starting from this one" onClick={() => switchVersion("new")}><Plus /></button>
            </div>
            <label className="small">Name<input value={doc.name} maxLength={80}
              onChange={(e) => { const name = e.target.value; setDoc((d) => ({ ...d, name })); setDirty(true); }} /></label>
            <div className="row">
              <button className="primary grow" disabled={saving || (!dirty && !!base.id)} onClick={() => save(false)}><Save /> {base.id ? "Save" : "Save version"}</button>
              {base.id && <button disabled={saving} onClick={() => save(true)} title="Keep this version as it was and save your changes as a new one"><Copy /> Save as new</button>}
            </div>
            {current && <div className="tiny muted">Saved by {author ?? "someone"}, {when.format(new Date(current.updated_at))}{dirty && " · unsaved changes"}</div>}
            {msg && <div className={`small ${msg.bad ? "error" : "muted"}`}>{msg.text}</div>}
            {base.id && <ConfirmButton className="link danger-link small" label="Delete this version" question="Delete this version for everyone?" yes="Delete" onConfirm={deleteVersion} />}
          </section>

          <section>
            <div className="section-title">Scale</div>
            {scaled
              ? <div className="small">1 m = {doc.px_per_m!.toFixed(1)} plan pixels. <button className="link" onClick={() => chooseTool("scale")}>Set it again</button></div>
              : <div className="small">Not set. <button className="link" onClick={() => chooseTool("scale")}>Set the scale</button></div>}
          </section>

          {selectedShape && (
            <section>
              <div className="section-title">Selected</div>
              {selectedShape.type === "furniture" && (
                <FurnitureEditor s={selectedShape} onChange={(s) => update(s.id, () => s)} />
              )}
              {selectedShape.type === "text" && (
                <label className="small">Note<input value={selectedShape.text}
                  onChange={(e) => update(selectedShape.id, (s) => (s.type === "text" ? { ...s, text: e.target.value } : s))} /></label>
              )}
              {selectedShape.type === "rect" && scaled && (
                <div className="small">{metres(selectedShape.w / doc.px_per_m!)} × {metres(selectedShape.h / doc.px_per_m!)}</div>
              )}
              <div className="row">
                <button className="small-btn" onClick={() => duplicate(selectedShape)}><Copy /> Duplicate</button>
                <button className="small-btn danger" onClick={() => remove(selectedShape.id)}><Trash /> Delete</button>
              </div>
            </section>
          )}

          <section>
            <div className="section-title"><Sofa /> Furniture</div>
            {!scaled && <div className="tiny muted">Set the scale to add furniture.</div>}
            <div className="tiny muted">Drag a piece onto the plan, or tap it and then tap where it goes.</div>
            {GROUPS.map((g) => (
              <details key={g} className="fp-group">
                <summary className="small">{g}</summary>
                {g === "Fridges" && (
                  <p className="tiny muted" style={{ margin: "2px 0 6px" }}>Typical sizes. Check your model and allow the air gap it
                    needs, usually 20–50 mm each side and more on top. Use <strong>Measure</strong> to check the space.</p>
                )}
                {g === "Doors & windows" && (
                  <p className="tiny muted" style={{ margin: "2px 0 6px" }}>A door's wall is along its bottom edge. Rotate it to fit.</p>
                )}
                <div className="fp-palette">
                  {FURNITURE.filter((f) => f.group === g).map((f) => (
                    <button key={f.key} disabled={!scaled} draggable={scaled} className={tool === `furniture:${f.key}` ? "on" : ""}
                      onDragStart={(e) => e.dataTransfer.setData("text/x-furniture", f.key)}
                      onClick={() => { chooseTool(`furniture:${f.key}`); setSheetOpen(false); }} style={{ borderLeftColor: GROUP_COLOUR[f.group] }}>
                      <FurniturePreview item={f.key} />
                      <span className="fp-pal-name">{f.label}</span>
                      <span className="tiny muted">{f.w} × {f.h} m{f.tall ? `, ${f.tall} m tall` : ""}</span>
                    </button>
                  ))}
                </div>
              </details>
            ))}
          </section>
          <div className="tiny muted fp-keys">
            <p>Scroll or pinch to zoom. Drag the plan, or hold Space, to pan. Press 0 to fit.</p>
            <p>Drag a selected shape's handles to reshape it, and a piece's round handle to turn it. Hold Alt for any angle and no
              snapping.</p>
            <p>Arrow keys nudge. R turns furniture 90°. Delete removes. Ctrl+Z undoes. Esc cancels.</p>
          </div>
        </aside>}
      </div>
    </div>
  );
}

function FurnitureEditor({ s, onChange }: { s: Extract<Shape, { type: "furniture" }>; onChange: (s: Extract<Shape, { type: "furniture" }>) => void }) {
  const [w, setW] = useState(String(s.w)), [h, setH] = useState(String(s.h));
  useEffect(() => { setW(String(s.w)); setH(String(s.h)); }, [s.id, s.w, s.h]);
  const apply = () => {
    const nw = parseLength(w), nh = parseLength(h);
    if (nw && nh && (nw !== s.w || nh !== s.h)) onChange({ ...s, w: nw, h: nh });
  };
  return (
    <div className="stack" style={{ gap: 6 }}>
      <label className="small">Label<input value={s.label} onChange={(e) => onChange({ ...s, label: e.target.value })} /></label>
      <div className="grid2">
        <label className="small">Width (m)<input value={w} inputMode="decimal" onChange={(e) => setW(e.target.value)} onBlur={apply}
          onKeyDown={(e) => e.key === "Enter" && apply()} /></label>
        <label className="small">Depth (m)<input value={h} inputMode="decimal" onChange={(e) => setH(e.target.value)} onBlur={apply}
          onKeyDown={(e) => e.key === "Enter" && apply()} /></label>
      </div>
      <div className="row">
        <button className="small-btn" title="Rotate left 15°" onClick={() => onChange({ ...s, rotation: (s.rotation + 345) % 360 })}><RotateCcw /> 15°</button>
        <button className="small-btn" title="Rotate right 15°" onClick={() => onChange({ ...s, rotation: (s.rotation + 15) % 360 })}><RotateCw /> 15°</button>
        <button className="small-btn" title="Rotate 90°" onClick={() => onChange({ ...s, rotation: (s.rotation + 90) % 360 })}><RotateCw /> 90°</button>
      </div>
    </div>
  );
}

function ScaleDialog({ pixels, onSet, onCancel }: { pixels: number; onSet: (metres: number) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  const m = parseLength(text);
  return (
    <div className="fp-dialog" role="dialog" aria-label="Set the scale">
      <strong>How long is that line?</strong>
      <p className="small muted" style={{ margin: 0 }}>Enter it as printed on the plan, e.g. 3.6 or 3600 mm.</p>
      <input autoFocus value={text} placeholder="e.g. 3.6 m" inputMode="decimal" onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && m) onSet(m); if (e.key === "Escape") onCancel(); }} />
      {m && <div className="tiny muted">{metres(m)}: 1 m = {(pixels / m).toFixed(1)} plan pixels</div>}
      <div className="row">
        <button className="primary" disabled={!m} onClick={() => m && onSet(m)}>Set scale</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function TextDialog({ initial, onSet, onCancel }: { initial: string; onSet: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(initial);
  return (
    <div className="fp-dialog" role="dialog" aria-label="Add a note">
      <strong>Note</strong>
      <input autoFocus value={text} maxLength={120} placeholder="e.g. Needs new carpet" onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && text.trim()) onSet(text.trim()); if (e.key === "Escape") onCancel(); }} />
      <div className="row">
        <button className="primary" disabled={!text.trim()} onClick={() => onSet(text.trim())}>Add</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
