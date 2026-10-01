// Timing a day's visits in order: when you'd get to each one, driving from the one before, and whether that works. Used
// by the planner (which can start from a place) and the Inspections page (which warns about the connections that don't).

export type Leg = { distance_m: number; duration_s: number } | null;
export type Visit = { id: string; type: string; starts_at: string; ends_at: string | null };
export type Late = "no" | "after-start" | "missed";
export type Stop = { arrive: number; leg: Leg; late: Late };

/** A drive this long between two inspections is worth a second look, even when there's time for it. */
export const LONG_DRIVE_MIN = 30;
/** How late past the start still counts as on time. */
const GRACE_MS = 5 * 60_000;

/** Arrival times: be at the first opening (or leave the start in time), then drive, stay, drive… `legs` are the drives
 *  between consecutive points (from the start place first, if there is one); `stay` is minutes at an inspection (an
 *  auction takes 30). */
export function buildTimeline(visits: Visit[], legs: Leg[], { hasStart, stay }: { hasStart: boolean; stay: number }): Map<string, Stop> {
  const out = new Map<string, Stop>();
  let clock: number | null = null;
  visits.forEach((e, i) => {
    const opens = new Date(e.starts_at).getTime(), closes = new Date(e.ends_at ?? e.starts_at).getTime();
    const leg = hasStart ? legs[i] ?? null : i > 0 ? legs[i - 1] ?? null : null;
    const drive = leg ? leg.duration_s * 1000 : 0;
    const arrive: number = clock == null ? opens : clock + drive;
    const late = arrive > closes ? "missed" : arrive > opens + GRACE_MS ? "after-start" : "no";
    out.set(e.id, { arrive, leg: i === 0 && !hasStart ? null : leg, late });
    clock = Math.max(arrive, opens) + (e.type === "auction" ? 30 : stay) * 60_000;
  });
  return out;
}

export type Drive = { mins: number; km: number; level?: "bad" | "warn"; text: string };
const clockFmt = new Intl.DateTimeFormat("en-AU", { hour: "numeric", minute: "2-digit" });

/** A day's route with its timing: each stop's arrival, the drive chip to show before each stop (a warning when you'd be
 *  late or the drive is long), which stops you'd arrive too late for, and the seconds spent driving in all. */
export function routeDrives(route: Visit[], legs: Leg[], opts: { hasStart: boolean; stay: number }) {
  const stops = buildTimeline(route, legs, opts);
  const drives = new Map<string, Drive>();
  const late = new Set<string>();
  let seconds = 0;
  for (const e of route) {
    const t = stops.get(e.id);
    if (!t?.leg) continue;
    const mins = Math.max(1, Math.round(t.leg.duration_s / 60)), km = Math.round(t.leg.distance_m / 100) / 10;
    seconds += t.leg.duration_s;
    if (t.leg.distance_m < 300 && t.late === "no") continue;   // the same place: nothing to say about the drive
    if (t.late === "missed") { late.add(e.id); drives.set(e.id, { mins, km, level: "bad", text: `${mins} min drive. You'd arrive at ${clockFmt.format(t.arrive)}, after it closes` }); }
    else if (t.late === "after-start") drives.set(e.id, { mins, km, level: "warn", text: `${mins} min drive. You'd arrive at ${clockFmt.format(t.arrive)}, after it starts` });
    else if (mins >= LONG_DRIVE_MIN) drives.set(e.id, { mins, km, level: "warn", text: `Long drive: ${mins} min · ${km} km` });
    else drives.set(e.id, { mins, km, text: `${mins} min drive · ${km} km` });
  }
  return { stops, drives, late, seconds };
}
