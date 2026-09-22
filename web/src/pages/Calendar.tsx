// Upcoming inspections, auctions and EOI closings, with the phone-calendar subscription (milestone 3).
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api";

type Event = { type: string; id: string; kind: string; state: string; starts_at: string; ends_at: string | null; property_id: string; address: string };

const KIND: Record<string, string> = {
  open: "Open for inspection", private: "Private inspection", second_look: "Second look", building_pest: "Building & pest",
  display_suite: "Display suite", pre_settlement: "Pre-settlement", other: "Inspection", auction: "Auction", eoi: "EOI closes",
};
const dayFmt = new Intl.DateTimeFormat("en-AU", { weekday: "long", day: "numeric", month: "long" });
const timeFmt = new Intl.DateTimeFormat("en-AU", { hour: "numeric", minute: "2-digit" });

export default function Calendar() {
  const { data = [], isPending } = useQuery({ queryKey: ["inspections", 21], queryFn: () => api<Event[]>("/api/inspections?days=21") });
  const days = new Map<string, Event[]>();
  for (const e of data) {
    const k = dayFmt.format(new Date(e.starts_at));
    days.set(k, [...(days.get(k) ?? []), e]);
  }
  const feed = `${location.host}/api/calendar.ics`;
  return (
    <div style={{ marginTop: 12 }}>
      <div className="card stack">
        <h2>In your phone's calendar</h2>
        <p className="small muted">Subscribe once: inspections, auctions and EOI closings appear automatically, with a reminder an hour before. It refreshes whenever your phone can reach House Track.</p>
        <div className="row">
          <a href={`webcal://${feed}`}><button className="primary">Subscribe</button></a>
          <button onClick={() => navigator.clipboard?.writeText(`${location.protocol}//${feed}`)}>Copy link</button>
        </div>
      </div>
      {isPending && <p className="muted">Loading…</p>}
      {!isPending && data.length === 0 && <p className="muted">Nothing in the next three weeks. Add inspections from a house's page.</p>}
      {[...days.entries()].map(([day, events]) => (
        <div key={day} className="card">
          <h3>{day}</h3>
          <ul className="history">
            {events.map((e) => (
              <li key={`${e.type}-${e.id}`} className="row">
                <span className="grow">
                  <strong>{timeFmt.format(new Date(e.starts_at))}</strong> {KIND[e.kind] ?? e.kind}
                  {e.state !== "planned" && <span className="muted"> ({e.state})</span>}
                  <br /><Link to={`/p/${e.property_id}`}>{e.address}</Link>
                </span>
                <a className="small" href={`/api/events/${e.type}/${e.id}.ics`}>Add to calendar</a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
