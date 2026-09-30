// Rate new houses one at a time: swipe right for yes, left for no, down for maybe, and up to shortlist it (a yes that
// also puts it on the shortlist and the To inspect list). Or tap the buttons, or use the arrow keys. A comment is
// optional. It's only the houses you haven't given a verdict or comment on, newest added first. Each verdict is
// yours, before inspecting (after, if you've been to one), and goes through the outbox like any other.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bath, BedDouble, Car, CircleHelp, ExternalLink, GraduationCap, LandPlot, Star, ThumbsDown, ThumbsUp, TrainFront, Undo2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Link } from "react-router-dom";
import { api, type PropertyDetail, type Stance } from "../api";
import { LABEL, landArea, listingState, money, moneyRange, saleEnded } from "../format";
import { catalogue, display, type OverviewPlace, type OverviewRow } from "../overview/columns";
import { newId, sendOrQueue } from "../outbox";
import { usePeople } from "../people";

type Overview = { rows: OverviewRow[]; places: OverviewPlace[] };

/** Still to rate: no verdict (so no comment either) from this person yet, and still worth one (not ruled out,
 *  bought or sold). */
export const unrated = (r: OverviewRow, personId: string) =>
  r[`v:${personId}:pre`] == null && r[`v:${personId}:post`] == null
  && !["ruled_out", "missed_out", "bought"].includes(String(r.status))
  && !saleEnded(r.outcome, r.bought_by_us) && listingState(r.listing_status) !== "sold";

const REDUCED_MOTION = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const OUT_MS = REDUCED_MOTION ? 120 : 220;
/** What a swipe does: a verdict, or shortlisting (a yes, plus the shortlist and To inspect). */
type Pick = Stance | "shortlist";
const STAMP: Record<Pick, string> = { yes: "Yes", no: "No", maybe: "Maybe", shortlist: "Shortlist" };

export default function Rate() {
  const { all: persons, active, me } = usePeople();
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ["overview"], queryFn: () => api<Overview>("/api/overview") });
  const cols = useMemo(() => catalogue(persons, data?.places ?? []), [persons, data?.places]);
  // The line-up is fixed when the page opens, so saving a verdict (which refreshes the list) doesn't reshuffle it.
  const [queue, setQueue] = useState<string[] | null>(null);
  useEffect(() => {
    if (data && me && queue == null) {
      setQueue(data.rows.filter((r) => unrated(r, me.id))
        .sort((a, b) => String(b.added_at ?? "").localeCompare(String(a.added_at ?? ""))).map((r) => r.id));
    }
  }, [data, me, queue]);
  const [pos, setPos] = useState(0);
  const [given, setGiven] = useState<Record<string, { pick: Pick; note: string }>>({});
  const [note, setNote] = useState("");
  const [leaving, setLeaving] = useState<Pick | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const byId = useMemo(() => new Map((data?.rows ?? []).map((r) => [r.id, r])), [data]);
  const current = queue && byId.get(queue[pos]);
  const next = queue && byId.get(queue[pos + 1]);
  // The next house's photos load while you look at this one.
  useEffect(() => {
    if (next) queryClient.prefetchQuery({ queryKey: ["property", next.id], queryFn: () => api<PropertyDetail>(`/api/properties/${next.id}`) });
  }, [next, queryClient]);

  async function save(r: OverviewRow, stance: Stance, text: string, again: boolean) {
    if (!me) return;
    const attended = ((r.attended_by as string[] | undefined) ?? []).includes(me.id);
    const stage = attended ? "post_inspection" : "pre_inspection", short = attended ? "post" : "pre";
    const id = newId();
    try {
      const result = await sendOrQueue({
        id, method: "POST", path: `/api/properties/${r.id}/opinions`, propertyId: r.id,
        label: `${me.display_name}: ${LABEL.stance[stance]} for ${String(r.address)}`,
        // A second go at a house you've just rated replaces it; otherwise it's checked against what the phone saw.
        body: { id, person_id: me.id, stage, stance, note: text.trim() || null, recorded_at: new Date().toISOString(),
                check_latest: !again, expected_latest_id: again ? null : r._v?.[`v:${me.id}:${short}`] ?? null },
      });
      queryClient.setQueryData<Overview>(["overview"], (old) => old && {
        ...old, rows: old.rows.map((x) => (x.id === r.id ? { ...x, [`v:${me.id}:${short}`]: stance } : x)) });
      if (result === "queued") setFlash("Saved on this phone. It sends when you're back online.");
      else queryClient.invalidateQueries({ queryKey: ["overview"] });
    } catch (e) {
      setFlash(`Couldn't save ${String(r.address)}: ${(e as Error).message}`);
    }
  }

  /** Shortlisting: onto the shortlist and To inspect (or back off To inspect when a second go picks otherwise). */
  async function inspectList(r: OverviewRow, on: boolean) {
    try {
      if (on) {
        const result = await sendOrQueue({ id: newId(), method: "POST", path: `/api/properties/${r.id}/shortlist`, propertyId: r.id,
          body: {}, label: `Shortlist ${String(r.address)}` });
        if (result === "queued") setFlash("Saved on this phone. It sends when you're back online.");
      } else {
        await api(`/api/properties/${r.id}/inspect-list`, { method: "DELETE" });
      }
      queryClient.invalidateQueries({ queryKey: ["overview"] });
    } catch (e) {
      setFlash(`Couldn't ${on ? "shortlist" : "update"} ${String(r.address)}: ${(e as Error).message}`);
    }
  }

  function decide(pick: Pick) {
    if (!current || leaving) return;
    const before = given[current.id];
    setLeaving(pick);
    save(current, pick === "shortlist" ? "yes" : pick, note, before != null);
    if (pick === "shortlist") inspectList(current, true);
    else if (before?.pick === "shortlist") inspectList(current, false);
    setGiven((g) => ({ ...g, [current.id]: { pick, note } }));
    window.setTimeout(() => { setPos((p) => p + 1); setNote(""); setLeaving(null); }, OUT_MS);
  }
  function back() {
    if (!queue || pos === 0 || leaving) return;
    setNote(given[queue[pos - 1]]?.note ?? "");
    setPos(pos - 1);
  }

  // ← no, → yes, ↓ maybe, ↑ shortlist, Backspace back; not while typing a comment.
  const keys = useRef({ decide, back });
  keys.current = { decide, back };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("textarea, input, select")) return;
      const k = { ArrowRight: "yes", ArrowLeft: "no", ArrowDown: "maybe", ArrowUp: "shortlist" }[e.key] as Pick | undefined;
      if (k) { e.preventDefault(); keys.current.decide(k); } else if (e.key === "Backspace") { e.preventDefault(); keys.current.back(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 4000);
    return () => window.clearTimeout(t);
  }, [flash]);

  if (!data || !me || queue == null) return <p className="muted">Loading…</p>;
  const left = queue.length - pos;
  const earlier = current && given[current.id];
  return (
    <div className="rate">
      <div className="rate-head">
        <h1>Rate new houses</h1>
        <span className="muted small">{left > 0 ? `${left} to go` : ""}</span>
        <span className="grow" />
        <Link to="/">Done</Link>
      </div>
      {!current ? (
        <div className="card empty rate-done">
          <p><strong>{queue.length ? "That's all of them." : "Nothing new to rate."}</strong></p>
          <p className="small muted">New houses appear here until you rate them.</p>
          <div className="row" style={{ justifyContent: "center" }}>
            {pos > 0 && <button onClick={back}><Undo2 /> Back one</button>}
            <Link to="/"><button className="primary">Back to houses</button></Link>
          </div>
        </div>
      ) : (
        <>
          <div className="rate-stack">
            {next && <RateCard key={next.id} r={next} cols={cols} people={active} me={me.id} behind />}
            <RateCard key={current.id} r={current} cols={cols} people={active} me={me.id} leaving={leaving} onDecide={decide} />
          </div>
          {earlier && <p className="small muted rate-earlier">
            {earlier.pick === "shortlist" ? "You shortlisted it" : `You said ${LABEL.stance[earlier.pick]}`}. Pick again to change it.</p>}
          <textarea className="rate-note" rows={2} placeholder="Comment (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="rate-buttons">
            <button className="rate-btn back" onClick={back} disabled={pos === 0} title="Back one (Backspace)"><Undo2 /><span>Back</span></button>
            <button className="rate-btn no" onClick={() => decide("no")} title="No (←)"><ThumbsDown /><span>No</span></button>
            <button className="rate-btn maybe" onClick={() => decide("maybe")} title="Maybe (↓)"><CircleHelp /><span>Maybe</span></button>
            <button className="rate-btn yes" onClick={() => decide("yes")} title="Yes (→)"><ThumbsUp /><span>Yes</span></button>
            <button className="rate-btn shortlist" onClick={() => decide("shortlist")} title="Shortlist and add to To inspect (↑)"><Star /><span>Shortlist</span></button>
          </div>
          <p className="small muted rate-hint">Swipe right for yes, left for no, down for maybe, up to shortlist.</p>
        </>
      )}
      {flash && <div className="rate-flash" role="status">{flash}</div>}
    </div>
  );
}

/** One house as a card you can throw: it follows your finger, tilts as it goes, shows what it'll do, and flies off
 *  past a third of its width or height (or a quick flick); short of that it springs back. */
function RateCard({ r, cols, people, me, behind, leaving, onDecide }: {
  r: OverviewRow; cols: ReturnType<typeof catalogue>; people: { id: string; display_name: string; colour: string }[]; me: string;
  behind?: boolean; leaving?: Pick | null; onDecide?: (s: Pick) => void;
}) {
  const detail = useQuery({ queryKey: ["property", r.id], queryFn: () => api<PropertyDetail>(`/api/properties/${r.id}`), enabled: !behind });
  const photos = useMemo(() => {
    const all = (detail.data?.attachments ?? []).filter((a) => a.kind === "photo" && a.sha256 && a.mime_type?.startsWith("image/"));
    const listing = (a: (typeof all)[number]) => a.caption === "From the listing";
    return all.sort((a, b) => Number(b.id === r.cover_id) - Number(a.id === r.cover_id) || Number(listing(b)) - Number(listing(a))
      || a.created_at.localeCompare(b.created_at)).map((a) => a.id).slice(0, 12);
  }, [detail.data, r.cover_id]);
  const shown = photos.length ? photos : r.cover_id ? [String(r.cover_id)] : [];
  const [photo, setPhoto] = useState(0);

  const el = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState({ x: 0, y: 0, on: false });
  const start = useRef<{ x: number; y: number; t: number; moved: boolean; id: number } | null>(null);
  const last = useRef<{ x: number; y: number; t: number }[]>([]);
  const width = () => el.current?.offsetWidth ?? 360;

  function down(e: ReactPointerEvent) {
    if (behind || leaving || (e.target as HTMLElement).closest("a, button")) return;
    start.current = { x: e.clientX, y: e.clientY, t: e.timeStamp, moved: false, id: e.pointerId };
    last.current = [{ x: e.clientX, y: e.clientY, t: e.timeStamp }];
    el.current?.setPointerCapture(e.pointerId);
  }
  function move(e: ReactPointerEvent) {
    const s = start.current;
    if (!s || e.pointerId !== s.id) return;
    const x = e.clientX - s.x, y = e.clientY - s.y;
    if (!s.moved && Math.hypot(x, y) < 8) return;   // a tap, so far
    s.moved = true;
    last.current = [...last.current.filter((p) => e.timeStamp - p.t < 100), { x: e.clientX, y: e.clientY, t: e.timeStamp }];
    setDrag({ x, y, on: true });
  }
  function up(e: ReactPointerEvent) {
    const s = start.current;
    start.current = null;
    if (!s || e.pointerId !== s.id) return;
    if (!s.moved) {
      // A tap on the photo: its left third goes back a photo, the rest forward.
      const box = el.current?.querySelector(".rate-photo")?.getBoundingClientRect();
      if (box && e.clientY >= box.top && e.clientY <= box.bottom && shown.length > 1) {
        const forward = e.clientX > box.left + box.width / 3;
        setPhoto((i) => (forward ? Math.min(shown.length - 1, i + 1) : Math.max(0, i - 1)));
      }
      return;
    }
    // Speed over the last 100 ms, so a flick counts even when it's short.
    const p0 = last.current[0], dt = Math.max(1, e.timeStamp - p0.t);
    const vx = (e.clientX - p0.x) / dt, vy = (e.clientY - p0.y) / dt;
    const x = e.clientX - s.x, y = e.clientY - s.y, w = width();
    const upDown = Math.abs(y) > Math.abs(x);
    const pick: Pick | null = upDown && (-y > w * 0.35 || vy < -0.6) ? "shortlist"
      : upDown && (y > w * 0.35 || vy > 0.6) ? "maybe"
      : !upDown && (x > w * 0.33 || vx > 0.6) ? "yes" : !upDown && (x < -w * 0.33 || vx < -0.6) ? "no" : null;
    if (pick) {
      setDrag({ x, y, on: false });
      onDecide?.(pick);
    } else {
      setDrag({ x: 0, y: 0, on: false });
    }
  }

  // Where it is: following the finger, flying off with the verdict, or at rest.
  const w = width();
  const [tx, ty] = leaving === "yes" ? [w * 1.5, drag.y] : leaving === "no" ? [-w * 1.5, drag.y]
    : leaving === "shortlist" ? [drag.x, -window.innerHeight] : leaving === "maybe" ? [drag.x, window.innerHeight] : [drag.x, drag.y];
  const tilt = behind ? 0 : Math.max(-18, Math.min(18, tx / 20));
  const lean: Pick | null = leaving ?? (!drag.on ? null : Math.abs(drag.y) > Math.abs(drag.x) ? (drag.y < 0 ? "shortlist" : "maybe")
    : drag.x > 0 ? "yes" : "no");
  const strength = leaving ? 1 : lean === "shortlist" || lean === "maybe" ? Math.min(1, Math.abs(drag.y) / (w * 0.35))
    : Math.min(1, Math.abs(drag.x) / (w * 0.33));
  const style = behind ? undefined : {
    transform: `translate(${tx}px, ${ty}px) rotate(${tilt}deg)`,
    transition: drag.on ? "none" : leaving ? `transform ${OUT_MS}ms cubic-bezier(0.4, 0, 1, 1)` : "transform 260ms cubic-bezier(0.2, 0, 0, 1)",
  };

  const col = (k: string) => cols.find((c) => c.key === k)!;
  const n = (k: string) => (r[k] as number | null) ?? null;
  const sale = r.sale_at ? `${display(col("sale_method"), r.sale_method)} ${display(col("sale_at"), r.sale_at)}`
    : r.sale_method ? display(col("sale_method"), r.sale_method) : "Not listed";
  const underOffer = listingState(r.listing_status) === "underoffer";
  const schools = [...new Set([r.school_primary, r.school_secondary].filter(Boolean).map(String))];
  const others = people.filter((p) => p.id !== me).map((p) => {
    const short = r[`v:${p.id}:post`] != null ? "post" : "pre";
    return { p, stance: r[`v:${p.id}:${short}`] as Stance | undefined, note: r[`v:${p.id}:${short}:note`] as string | undefined };
  }).filter((x) => x.stance);

  return (
    <div ref={el} className={`card rate-card ${behind ? "behind" : ""}`} style={style}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} aria-hidden={behind}>
      <div className="rate-photo">
        {shown.length > 0 ? <img src={`/api/attachments/${shown[Math.min(photo, shown.length - 1)]}/file`} alt="" draggable={false} />
          : <div className="rate-nophoto muted">No photo yet</div>}
        {shown.length > 1 && (
          <div className="rate-dots" aria-hidden>{shown.map((id, i) => <span key={id} className={i === photo ? "on" : ""} />)}</div>
        )}
        {lean && <span className={`rate-stamp ${lean}`} style={{ opacity: strength }}>{STAMP[lean]}</span>}
        <div className="rate-caption">
          <div className="rate-address">{String(r.address)}</div>
          <div className="small">{String(r.suburb)}</div>
        </div>
      </div>
      <div className="rate-info">
        <div className="rate-price">
          <strong>{n("guide_low") == null ? "No guide" : moneyRange(n("guide_low"), n("guide_high"))}</strong>
          <span className="small muted">{sale}</span>
          {underOffer && <span className="pill maybe">Under offer</span>}
          {Boolean(r.to_inspect) && <span className="pill">To inspect</span>}
        </div>
        <div className="pc-facts">
          {r.beds != null && <span><BedDouble /> {String(r.beds)}</span>}
          {r.baths != null && <span><Bath /> {String(r.baths)}</span>}
          {r.car_spaces != null && <span><Car /> {String(r.car_spaces)}</span>}
          {r.land_m2 != null && <span><LandPlot /> {landArea(Number(r.land_m2))}</span>}
          {r.walk_away != null && <span className="muted">our max {money(n("walk_away"))}</span>}
        </div>
        {Boolean(r.nearest_station) && (
          <div className="small"><TrainFront /> {String(r.nearest_station)}
            {r.nearest_station_walk != null && <span className="muted"> · {String(r.nearest_station_walk)} min walk</span>}</div>
        )}
        {schools.length > 0 && <div className="small"><GraduationCap /> {schools.join(" · ")}</div>}
        {others.map(({ p, stance, note }) => (
          <div key={p.id} className="small rate-other">
            <span className="dot" style={{ background: p.colour }} />{p.display_name}: <span className={`pill ${stance}`}>{LABEL.stance[stance!]}</span>
            {note && <span className="muted"> “{note}”</span>}
          </div>
        ))}
        <Link to={`/p/${r.id}`} className="small rate-open">Open the house <ExternalLink /></Link>
      </div>
    </div>
  );
}
