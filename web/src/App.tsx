import { lazy, Suspense, useState } from "react";
import { Link, NavLink, Route, Routes } from "react-router-dom";
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
import { usePersons } from "./people";

// The map pulls in MapLibre and the drawing tools; load it only when opened.
const MapPage = lazy(() => import("./pages/MapPage"));
const Overview = lazy(() => import("./pages/Overview"));

export default function App() {
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
        <NavLink to="/" className="brand">House Track</NavLink>
        <nav>
          <NavLink to="/" end>Houses</NavLink>
          <NavLink to="/map">Map</NavLink>
          <NavLink to="/overview" className="desktop-only">Overview</NavLink>
          <NavLink to="/drive">Drive</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        {queued.length > 0 && (
          <Link to="/outbox" className={`badge ${queued.some((q) => q.conflict) ? "warn" : ""}`} title="Waiting to send">⇅ {queued.length}</Link>
        )}
        <button className="link" onClick={() => choose(null)} title="Switch person">
          <span className="dot" style={{ background: me.colour }} />
          {me.display_name}
        </button>
      </header>
      <main className="shell">
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
          <Route path="/disagree" element={<Disagreements />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<p>Page not found.</p>} />
        </Routes>
      </main>
    </>
  );
}
