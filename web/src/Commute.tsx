// Travel times, drawn the same way everywhere (house page, map panel): one row per place with only the ways
// you'd actually go. Walks too long to matter are left out, a drive is its peak-hour figure (the no-traffic time
// is in its tooltip), and a public transport time opens the trip there and home, each leg with its time.
import { Car, Footprints, Info, MapPin, School, TrainFront, TramFront } from "lucide-react";
import { useState } from "react";
import type { Transit, TransitLeg, Travel } from "./api";
import { minutesTone } from "./colour";
import { minutes } from "./format";
import { usePeople } from "./people";

/** Walks longer than this aren't a way anyone would go, so they aren't shown. */
const WALK_WORTH_S = 45 * 60;
/** Past this, the walk to school is shown with the drive (the server only works the drive out then). */
const SCHOOL_WALK_S = 35 * 60;
const clock = new Intl.DateTimeFormat("en-AU", { hour: "numeric", minute: "2-digit" });
const tone = (s: number, mode: "walk" | "drive" | "transit") => `tone-${minutesTone(s / 60, mode)}`;

type Station = { name: string; walk_s: number | null; drive_s: number | null };

function Time({ icon, s, mode, title }: { icon: React.ReactNode; s: number; mode: "walk" | "drive" | "transit"; title: string }) {
  return <span className="commute-time" title={title}>{icon}<span className={tone(s, mode)}>{minutes(s)}</span></span>;
}

const at = (iso: string | null | undefined) => (iso ? clock.format(new Date(iso)) : "");

/** Each leg with the time it starts: "7:54 Walk 21 min · 8:15 Hurstbridge train 25 min to Flinders Street · …". */
function Legs({ legs, arrive, late }: { legs: TransitLeg[]; arrive: string | null; late?: boolean }) {
  return (
    <ol className="commute-legs">
      {legs.map((l, i) => (
        <li key={i} className={l.mode === "walk" ? "walk" : ""}>
          <span className="commute-leg-at">{at(l.at)}</span>
          {l.mode === "walk" ? `Walk ${l.minutes} min` : <><strong>{l.name ? `${l.name} ` : ""}{l.mode}</strong> {l.minutes} min{l.to && <span className="muted"> to {l.to}</span>}</>}
        </li>
      ))}
      {arrive && <li className="arrive"><span className="commute-leg-at">{at(arrive)}</span><span className={late ? "tone-bad" : ""}>Arrive{late ? " (after 9)" : ""}</span></li>}
    </ol>
  );
}

function TripLines({ j }: { j: Transit }) {
  const late = !!j.arrive_at && new Date(j.arrive_at).getTime() > new Date(j.arrive_by).getTime();
  return (
    <div className="commute-trip tiny">
      <div className="muted">There by 9 · {minutes(j.duration_s)}</div>
      <Legs legs={j.legs} arrive={j.arrive_at} late={late} />
      {j.home && <>
        <div className="muted" style={{ marginTop: 4 }}>Home, leaving after 5 · {minutes(j.home.duration_s)}</div>
        <Legs legs={j.home.legs} arrive={j.home.arrive_at} />
      </>}
    </div>
  );
}

export default function Commute({ travel, station, stationNote, note = true }: {
  travel: Travel; station?: Station | null; stationNote?: React.ReactNode; note?: boolean;
}) {
  const { byId } = usePeople();
  const [open, setOpen] = useState<string | null>(null);
  const [explain, setExplain] = useState(false);
  const nearest = station ?? travel.nearest;
  const picked = travel.stations.filter((s) => s.name !== nearest?.name && s.duration_s <= WALK_WORTH_S);
  const anyPeak = travel.destinations.some((d) => d.drive_peak_s != null);
  const anyTransit = travel.destinations.some((d) => d.transit?.duration_s != null);

  return (
    <div className="commute">
      {nearest && (
        <div className="commute-row">
          <span className="commute-to"><TrainFront /> <strong>{nearest.name}</strong><span className="muted small"> station</span></span>
          {nearest.walk_s != null && nearest.walk_s <= WALK_WORTH_S && <Time icon={<Footprints />} s={nearest.walk_s} mode="walk" title="Walk" />}
          {nearest.drive_s != null && <Time icon={<Car />} s={nearest.drive_s} mode="drive" title="Drive" />}
        </div>
      )}
      {stationNote}
      {picked.map((s) => (
        <div key={s.place_id} className="commute-row">
          <span className="commute-to"><TrainFront /> {s.name}<span className="muted small"> station</span></span>
          <Time icon={<Footprints />} s={s.duration_s} mode="walk" title="Walk" />
        </div>
      ))}
      {(travel.schools ?? []).map((s) => (
        <div key={s.level} className="commute-row">
          <span className="commute-to" title={`Zoned ${s.level === "primary" ? "primary" : "Year 7"} school`}>
            <School /> {s.name}
            <span className="muted small"> {s.level === "primary" ? "primary" : "secondary"} zone</span></span>
          {s.walk_s != null && s.walk_s <= WALK_WORTH_S && <Time icon={<Footprints />} s={s.walk_s} mode="walk" title="Walk" />}
          {s.drive_s != null && (s.walk_s == null || s.walk_s > SCHOOL_WALK_S) && <Time icon={<Car />} s={s.drive_s} mode="drive" title="Drive (no traffic)" />}
          {s.walk_s == null && s.drive_s == null && <span className="tiny muted">…</span>}
        </div>
      ))}
      {travel.destinations.map((d) => {
        const drive = d.drive_peak_s ?? d.drive_s;
        const pt = d.transit?.duration_s;
        const owner = d.person_id ? byId.get(d.person_id)?.display_name : null;
        return (
          <div key={d.place_id}>
            <div className="commute-row">
              <span className="commute-to"><MapPin /> {d.name}{owner && <span className="muted small"> ({owner}'s)</span>}</span>
              {d.walk_s != null && d.walk_s <= WALK_WORTH_S && <Time icon={<Footprints />} s={d.walk_s} mode="walk" title="Walk" />}
              {drive != null && (
                <Time icon={<Car />} s={drive} mode="drive"
                  title={d.drive_peak_s != null && d.drive_s != null ? `Peak-hour estimate. ${minutes(d.drive_s)} with no traffic.` : "Drive"} />
              )}
              {pt != null && (
                <button className={`commute-time commute-pt ${open === d.place_id ? "on" : ""}`} aria-expanded={open === d.place_id}
                  title="Public transport, arriving by 9am. Click for the trip."
                  onClick={() => setOpen(open === d.place_id ? null : d.place_id)}>
                  <TramFront /><span className={tone(pt, "transit")}>{minutes(pt)}</span>
                </button>
              )}
              {d.transit && pt == null && (
                <span className="commute-time tiny muted" title="Nothing gets you there by 9am unless you leave before 6am">
                  <TramFront />no practical trip</span>
              )}
            </div>
            {open === d.place_id && d.transit && <TripLines j={d.transit} />}
          </div>
        );
      })}
      {travel.pending > 0 && <div className="tiny muted">Working out travel times…</div>}
      {note && (anyPeak || anyTransit) && (
        <div className="tiny muted commute-note">
          {[anyPeak && "Drives at peak hour", anyTransit && "public transport there by 9am, home from 5pm"].filter(Boolean).join(" · ")}
          <button className="link" aria-label="How these are worked out" aria-expanded={explain} onClick={() => setExplain(!explain)}><Info /></button>
          {explain && (
            <div style={{ margin: "4px 0 0", display: "grid", gap: 4 }}>
              <p style={{ margin: 0 }}>Drive times are for peak hour. Freeways and main roads slow down the most, side streets hardly at
                all. Hover over a drive to see it with no traffic.</p>
              <p style={{ margin: 0 }}>Public transport is for a weekday: the latest trip that gets you there by 9am, and the first one home
                after 5pm. It walks up to 30 minutes to a station rather than take a bus, unless the bus saves 20 minutes or more. Trips
                that start before 6am don't count. Timetables are from PTV and V/Line, via <a href="https://transitous.org" target="_blank"
                rel="noreferrer">Transitous</a>.</p>
              <p style={{ margin: 0 }}>Schools are the government schools the house is zoned for. Walks over 45 minutes aren't shown.
                These are all estimates, so check before you rely on them.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
