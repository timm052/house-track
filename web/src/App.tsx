import { lazy, Suspense, useState } from "react";
import { Link, NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import ErrorBoundary from "./ErrorBoundary";
import { getActingPerson, setActingPerson } from "./api";
import { useOutbox } from "./outbox";
import Auction from "./pages/Auction";
import ThisWeek from "./pages/ThisWeek";
import { Compare } from "./pages/Decide";
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
import { ArrowUpDown, CalendarDays, DoorOpen, House, Map as MapIcon, MapPin, Settings as SettingsIcon, Sheet, TrendingUp } from "lucide-react";
import Plan from "./pages/Plan";

// The map pulls in MapLibre and the drawing tools; load it only when opened.
const MapPage = lazy(() => import("./pages/MapPage"));
const Overview = lazy(() => import("./pages/Overview"));
const Trends = lazy(() => import("./pages/Trends"));

// Lists, the house page and dashboards use the full width; forms and settings stay narrow.
const WIDE = [/^\/$/, /^\/week/, /^\/p\//, /^\/trends/, /^\/compare/, /^\/plan/];

/** The tabs, in the order of a house hunt: the list, what's on, where things are, then the tools. */
const NAV: { to: string; label: string; icon: React.ReactNode; desktopOnly?: boolean; end?: boolean }[] = [
  { to: "/", label: "Houses", icon: <House />, end: true },
  { to: "/week", label: "This week", icon: <CalendarDays /> },
  { to: "/map", label: "Map", icon: <MapIcon /> },
  { to: "/overview", label: "Grid", icon: <Sheet />, desktopOnly: true },
  { to: "/trends", label: "Trends", icon: <TrendingUp />, desktopOnly: true },
  { to: "/places", label: "Places", icon: <MapPin /> },
  { to: "/on-site", label: "On site", icon: <DoorOpen /> },
  { to: "/settings", label: "Settings", icon: <SettingsIcon /> },
];

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
        <nav aria-label="Main">
          {NAV.map(({ to, label, icon, desktopOnly, end }) => (
            <NavLink key={to} to={to} end={end} className={desktopOnly ? "desktop-only" : undefined} title={label} aria-label={label}>
              {icon}<span className="nav-label">{label}</span>
            </NavLink>
          ))}
        </nav>
        {queued.length > 0 && (
          <Link to="/outbox" className={`badge ${queued.some((q) => q.conflict) ? "warn" : ""}`} title="Waiting to send"><ArrowUpDown /> {queued.length}</Link>
        )}
        <button className="link" onClick={() => choose(null)} title="Switch person">
          <span className="dot" style={{ background: me.colour }} />
          <span className="person-name">{me.display_name}</span>
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
          <Route path="/on-site" element={<Driveway />} />
          <Route path="/drive" element={<Navigate to="/on-site" replace />} />
          <Route path="/week" element={<ThisWeek />} />
          <Route path="/calendar" element={<Navigate to="/week" replace />} />
          <Route path="/plan" element={<Plan />} />
          <Route path="/outbox" element={<Outbox />} />
          <Route path="/auction/:campaignId" element={<Auction />} />
          <Route path="/compare" element={<Compare />} />
          <Route path="/trends" element={<Suspense fallback={<p className="muted">Loading…</p>}><Trends /></Suspense>} />
          <Route path="/disagree" element={<Navigate to="/week" replace />} />
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
