import { lazy, Suspense, useState } from "react";
import { Link, NavLink, Route, Routes, useLocation } from "react-router-dom";
import ErrorBoundary from "./ErrorBoundary";
import { getActingPerson, setActingPerson } from "./api";
import { useOutbox } from "./outbox";
import Auction from "./pages/Auction";
import Calendar from "./pages/Calendar";
import { Compare, Disagreements } from "./pages/Decide";
import Driveway from "./pages/Driveway";
import Outbox from "./pages/Outbox";
import Places from "./pages/Places";
import PropertyDetail from "./pages/PropertyDetail";
import PropertyList from "./pages/PropertyList";
import QuickAdd from "./pages/QuickAdd";
import Settings from "./pages/Settings";
import Setup from "./pages/Setup";
import Refresh from "./pages/Refresh";
import { usePersons } from "./people";
import { ArrowUpDown } from "lucide-react";

// The map pulls in MapLibre and the drawing tools; load it only when opened.
const MapPage = lazy(() => import("./pages/MapPage"));
const Overview = lazy(() => import("./pages/Overview"));
const Trends = lazy(() => import("./pages/Trends"));

// Lists, the house page and dashboards use the full width; forms and settings stay narrow.
const WIDE = [/^\/$/, /^\/p\//, /^\/trends/, /^\/compare/];

export default function App() {
  const location = useLocation();
  const persons = usePersons();
  const [acting, setActing] = useState(getActingPerson());
  const queued = useOutbox();

  const choose = (id: string | null) => {
    setActingPerson(id);
    setActing(id);
  };

  if (persons.isPending) return <div className="center muted">Loading…</div>;
  if (persons.isError) return <div className="center error">Can't reach the House Track server.</div>;

  const active = persons.data.filter((p) => p.active);
  if (active.length === 0) return <Setup onDone={choose} />;

  const me = active.find((p) => p.id === acting);
  if (!me) {
    return (
      <div className="center">
        <div className="who">
          <h1>Who's using this device?</h1>
          {active.map((p) => (
            <button key={p.id} onClick={() => choose(p.id)} style={{ borderLeft: `8px solid ${p.colour}` }}>
              {p.display_name}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
      <header className="topbar">
        <NavLink to="/" className="brand" aria-label="House Track"><BrandMark /><span className="brand-name">House Track</span></NavLink>
        <nav>
          <NavLink to="/" end>Houses</NavLink>
          <NavLink to="/map">Map</NavLink>
          <NavLink to="/overview" className="desktop-only">Overview</NavLink>
          <NavLink to="/trends" className="desktop-only">Trends</NavLink>
          <NavLink to="/drive">Drive</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        {queued.length > 0 && (
          <Link to="/outbox" className={`badge ${queued.some((q) => q.conflict) ? "warn" : ""}`} title="Waiting to send"><ArrowUpDown /> {queued.length}</Link>
        )}
        <button className="link" onClick={() => choose(null)} title="Switch person">
          <span className="dot" style={{ background: me.colour }} />
          {me.display_name}
        </button>
      </header>
      <main className="shell">
        <ErrorBoundary resetKey={location.pathname}>
        <div className={WIDE.some((re) => re.test(location.pathname)) ? "" : "narrow"}>
        <Routes>
          <Route path="/" element={<PropertyList />} />
          <Route path="/add" element={<QuickAdd />} />
          <Route path="/p/:id" element={<PropertyDetail />} />
          <Route path="/map" element={<Suspense fallback={<p className="muted">Loading map…</p>}><MapPage /></Suspense>} />
          <Route path="/overview" element={<Suspense fallback={<p className="muted">Loading…</p>}><Overview /></Suspense>} />
          <Route path="/places" element={<Places />} />
          <Route path="/drive" element={<Driveway />} />
          <Route path="/calendar" element={<Calendar />} />
          <Route path="/outbox" element={<Outbox />} />
          <Route path="/auction/:campaignId" element={<Auction />} />
          <Route path="/compare" element={<Compare />} />
          <Route path="/trends" element={<Suspense fallback={<p className="muted">Loading…</p>}><Trends /></Suspense>} />
          <Route path="/disagree" element={<Disagreements />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/refresh" element={<Refresh />} />
          <Route path="*" element={<p>Page not found.</p>} />
        </Routes>
        </div>
        </ErrorBoundary>
      </main>
    </>
  );
}

/** A brick tile with a house drawn in one line: roof, walls, door. */
function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="9" fill="var(--brick)" />
      <path d="M7.5 15.5 16 8.5l8.5 7M10.5 13.5v10h11v-10M14.2 23.5v-5h3.6v5" fill="none" stroke="var(--surface)"
        strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
