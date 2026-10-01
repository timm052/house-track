// The week picker shared by Inspections and the route planner: Monday to Sunday as tiles (with a dot for each thing on),
// and the week arrows with a Today button. Days are local dates as "YYYY-MM-DD".
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";

const longDay = new Intl.DateTimeFormat("en-AU", { weekday: "long", day: "numeric", month: "long" });
const weekdayShort = new Intl.DateTimeFormat("en-AU", { weekday: "short" });
const dayMonth = new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short" });

export const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const at = (day: string) => new Date(`${day}T12:00`);
export const addDays = (day: string, n: number) => { const d = at(day); d.setDate(d.getDate() + n); return iso(d); };
export const monday = (day: string) => addDays(day, -((at(day).getDay() + 6) % 7));
/** "28 Sept – 4 Oct": the week a day is in. */
export const weekLabel = (day: string) => `${dayMonth.format(at(monday(day)))} – ${dayMonth.format(at(addDays(monday(day), 6)))}`;

/** Today (when you're not on it), and the previous and next week (you can't go back before this week). */
export function WeekNav({ day, today, onPick }: { day: string; today: string; onPick: (d: string) => void }) {
  return (
    <>
      {day !== today && <button className="small-btn" onClick={() => onPick(today)}>Today</button>}
      <div className="insp-weeknav">
        <button aria-label="Previous week" disabled={monday(day) <= monday(today)} onClick={() => onPick(addDays(day, -7))}><ChevronLeft /></button>
        <button aria-label="Next week" onClick={() => onPick(addDays(day, 7))}><ChevronRight /></button>
      </div>
    </>
  );
}

/** The week's seven days; `count` says how many things are on each (up to four dots). */
export function WeekBar({ day, today, count, onPick, noun = "inspection" }: {
  day: string; today: string; count: (d: string) => number; onPick: (d: string) => void; noun?: string;
}) {
  const start = monday(day);
  return (
    <div className="insp-days" role="group" aria-label={`Week of ${dayMonth.format(at(start))}`}>
      {Array.from({ length: 7 }, (_, i) => addDays(start, i)).map((d) => {
        const n = count(d);
        return (
          <button key={d} className={`insp-day ${d === day ? "on" : ""} ${d === today ? "today" : ""} ${n === 0 ? "empty" : ""}`}
            aria-pressed={d === day} aria-label={`${longDay.format(at(d))}, ${n} ${n === 1 ? noun : `${noun}s`}`} onClick={() => onPick(d)}>
            <span className="dow">{weekdayShort.format(at(d))}</span>
            <span className="num">{at(d).getDate()}</span>
            <span className="dots" aria-hidden>{Array.from({ length: Math.min(n, 4) }, (_, k) => <i key={k} />)}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Whether a media query matches, kept up to date. */
export function useMedia(query: string) {
  const [on, setOn] = useState(() => typeof matchMedia !== "undefined" && matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query), change = () => setOn(mq.matches);
    mq.addEventListener("change", change);
    return () => mq.removeEventListener("change", change);
  }, [query]);
  return on;
}
