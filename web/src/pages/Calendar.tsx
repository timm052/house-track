// Upcoming inspections, auctions and EOI closings, with the phone-calendar subscription (milestone 3).
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api";
import { suburbClass, useSuburbSlots } from "../colour";
import { EVENT_LABEL } from "../format";

type Event = { type: string; id: string; kind: string; state: string; starts_at: string; ends_at: string | null;
               property_id: string; address: string; suburb: string };

const KIND = EVENT_LABEL;
const DAYS = 60;  // auctions and EOI closings are often set a month or more out
const dayFmt = new Intl.DateTimeFormat("en-AU", { weekday: "long", day: "numeric", month: "long" });
const timeFmt = new Intl.DateTimeFormat("en-AU", { hour: "numeric", minute: "2-digit" });
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** "Today", "Tomorrow", or the date. */
function dayLabel(d: Date): string {
  const now = new Date(), tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const k = dayKey(d);
  const when = k === dayKey(now) ? "Today" : k === dayKey(tomorrow) ? "Tomorrow" : k === dayKey(yesterday) ? "Yesterday" : null;
  return when ? `${when} · ${dayFmt.format(d)}` : dayFmt.format(d);
}

/** The next two months, day by day, and the phone-calendar subscription: part of the This week tab. */
export default function CalendarSection() {
  const { data = [], isPending } = useQuery({ queryKey: ["inspections", DAYS], queryFn: () => api<Event[]>(`/api/inspections?days=${DAYS}`) });
  const slots = useSuburbSlots();
  const days = new Map<string, { date: Date; events: Event[] }>();
  for (const e of data) {
    const d = new Date(e.starts_at), k = dayKey(d);
    days.set(k, { date: d, events: [...(days.get(k)?.events ?? []), e] });
  }
  const sales = data.filter((e) => e.type === "auction" || e.type === "eoi").length;
  const feed = `${location.host}/api/calendar.ics`;
  return (
    <section id="calendar">
      <div className="row" style={{ marginTop: 20 }}><h2 className="grow" style={{ margin: 0 }}>Calendar</h2><Link to="/plan">Plan the inspections</Link></div>
      <p className="small muted">
        The next {DAYS / 30} months: {data.length - sales} {data.length - sales === 1 ? "inspection" : "inspections"},{" "}
        {sales} {sales === 1 ? "auction or EOI closing" : "auctions and EOI closings"}.
      </p>
      {isPending && <p className="muted">Loading…</p>}
      {!isPending && data.length === 0 && <div className="card empty">Nothing coming up. Add inspections from a house's page.</div>}
      {[...days.values()].map(({ date, events }) => (
        <div key={dayKey(date)} className="card">
          <h3>{dayLabel(date)}</h3>
          <ul className="cal-list">
            {events.map((e) => {
              const sale = e.type === "auction" || e.type === "eoi";
              return (
                <li key={`${e.type}-${e.id}`} className={`tint ${suburbClass(slots, e.suburb)} ${sale ? "sale" : ""}`}>
                  <strong className="cal-time">{timeFmt.format(new Date(e.starts_at))}</strong>
                  <span className="grow">
                    {sale ? <span className="pill cal-sale">{KIND[e.kind]}</span> : KIND[e.kind] ?? e.kind}
                    {e.state !== "planned" && <span className="muted"> ({e.state})</span>}
                    <br /><Link to={`/p/${e.property_id}`}>{e.address}</Link>
                  </span>
                  <a className="small" href={`/api/events/${e.type}/${e.id}.ics`} title="Download this one event">+ Calendar</a>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <div className="card stack">
        <h2>In your phone's calendar</h2>
        <p className="small muted" style={{ margin: 0 }}>Subscribe once: inspections, auctions and EOI closings appear automatically, with a reminder an hour before. It refreshes whenever your phone can reach House Track.</p>
        <div className="row">
          <a href={`webcal://${feed}`}><button className="primary">Subscribe</button></a>
          <button onClick={() => navigator.clipboard?.writeText(`${location.protocol}//${feed}`)}>Copy link</button>
        </div>
      </div>
    </section>
  );
}
