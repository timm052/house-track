// The map's Blocks panel (what to show, colour by, the preferences being tried, the suburbs ranked) and the sheet for a
// block you tap. See map/blocks.ts for the layers.
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, LocateFixed, X } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { AddSuburb, BlockFacts, PrefsEditor, samePrefs, suburbName, type Block, type BlockPrefs, type BlockSuburb } from "../blocks";
import { BLOCK_COLOURS, blockKey, fitOf, type BlockColour, type BlockProps } from "./blocks";

export type BlockView = "off" | "blocks" | "areas";
export type Street = { street: string; suburb: string; total: number; fit: number };

export function BlocksPanel({ view, setView, colour, setColour, prefs, household, setTrial, onSave, saving, suburbs, hidden, setHidden,
                              features, streets, areasLoading, onGoTo, hexSize, setHexSize, houseSuburbs }: {
  view: BlockView; setView: (v: BlockView) => void; colour: BlockColour; setColour: (c: BlockColour) => void;
  prefs: BlockPrefs; household: BlockPrefs | undefined; setTrial: (p: BlockPrefs | null) => void; onSave: () => void; saving: boolean;
  suburbs: BlockSuburb[]; hidden: string[]; setHidden: (s: string[]) => void;
  features: GeoJSON.Feature[]; streets: Street[] | undefined; areasLoading: boolean; onGoTo: (suburb: string) => void;
  hexSize: number; setHexSize: (n: number) => void; houseSuburbs: string[];
}) {
  const trying = household && !samePrefs(prefs, household);
  // Per suburb: how many blocks there are (houses and townhouses, or units too if they count) and how many fit.
  const tally = new Map<string, { total: number; fit: number }>();
  for (const f of features) {
    const p = f.properties as BlockProps;
    if (p.u && !prefs.include_units) continue;
    const t = tally.get(p.sub!) ?? { total: 0, fit: 0 };
    t.total += 1;
    if (fitOf(p, prefs) === 1) t.fit += 1;
    tally.set(p.sub!, t);
  }
  const all = [...tally.values()].reduce((a, t) => ({ total: a.total + t.total, fit: a.fit + t.fit }), { total: 0, fit: 0 });
  const ranked = [...suburbs].sort((a, b) => {
    const ta = tally.get(a.suburb), tb = tally.get(b.suburb);
    return (tb ? tb.fit / Math.max(tb.total, 1) : -1) - (ta ? ta.fit / Math.max(ta.total, 1) : -1) || a.suburb.localeCompare(b.suburb);
  });

  if (!suburbs.length) {
    return <>
      <p className="small">Blocks shows every property's block in the suburbs you choose, coloured by size, slope and whether it suits you,
        including houses that aren't for sale, so you can find streets worth watching.</p>
      <p className="small muted">Add a suburb to start (about a minute each). They're also in <Link to="/settings#blocks">Settings</Link>.</p>
      <AddSuburb have={[]} suggestions={houseSuburbs} />
    </>;
  }
  return <>
    <div className="map-seg" role="radiogroup" aria-label="Show">
      {([["off", "Off"], ["blocks", "Blocks"], ["areas", "Areas"]] as [BlockView, string][]).map(([v, t]) => (
        <button key={v} role="radio" aria-checked={view === v} className={view === v ? "on" : ""} onClick={() => setView(v)}>{t}</button>
      ))}
    </div>
    {view === "blocks" && <>
      <label className="bk-field"><span className="section-title">Colour blocks by</span>
        <select value={colour} onChange={(e) => setColour(e.target.value as BlockColour)}>
          {BLOCK_COLOURS.map(([c, label]) => <option key={c} value={c}>{label}</option>)}
        </select></label>
      <div className="map-key">
        {blockKey(colour, prefs).map(([c, text]) => <div key={text}><span className="key-area" style={{ borderColor: c, background: c }} />{text}</div>)}
        <div><span className="key-area" style={{ borderColor: "var(--accent)", background: "transparent", borderWidth: 2 }} />One of your houses</div>
      </div>
      <p className="small muted">Shown from suburb level; zoom in for the outlines. Tap a block for its slope and drop.</p>
    </>}
    {view === "areas" && <>
      <div className="map-key bk-ramp">
        <span>None fit</span><i style={{ background: "linear-gradient(90deg, #f1f3f5, #c3fae8, #63e6be, #12b886, #087f5b)" }} /><span>Most fit</span>
      </div>
      <div className="section-title">Area size</div>
      <div className="map-seg" role="radiogroup" aria-label="Area size">
        {[[150, "Small"], [250, "Medium"], [500, "Large"]].map(([n, t]) => (
          <button key={n} role="radio" aria-checked={hexSize === n} className={hexSize === n ? "on" : ""} onClick={() => setHexSize(n as number)}>{t}</button>
        ))}
      </div>
      <p className="small muted">Each hexagon is shaded by the share of its blocks that fit; zoomed in, it says how many.</p>
      {areasLoading && <p className="small muted">Working out the areas…</p>}
      {streets && streets.length > 0 && (
        <section>
          <div className="section-title">Streets with the most that fit</div>
          <ol className="bk-streets">
            {streets.map((s) => <li key={`${s.street}-${s.suburb}`}><span className="grow">{s.street}, {s.suburb}</span>
              <span className="muted">{s.fit} of {s.total}</span></li>)}
          </ol>
        </section>
      )}
    </>}

    {view !== "off" && <>
      <section className="bk-prefs">
        <div className="section-title">Your block {trying ? <span className="pill">trying on the map</span> : <span className="muted small">the household's</span>}</div>
        <PrefsEditor value={prefs} onChange={setTrial} />
        {trying && (
          <div className="row">
            <button className="primary" onClick={onSave} disabled={saving || prefs.max_m2 < prefs.min_m2}>{saving ? "Saving…" : "Save for the household"}</button>
            <button className="link" onClick={() => setTrial(null)}>Back to the household's</button>
          </div>
        )}
        {trying && <p className="small muted">Saving changes what the Houses list, the Grid and each house's page count as fitting.</p>}
      </section>
      <section>
        <div className="section-title">Suburbs {all.total > 0 && <span className="muted small">· {all.fit.toLocaleString()} of {all.total.toLocaleString()} blocks fit</span>}</div>
        <ul className="bk-suburbs">
          {ranked.map((s) => {
            const t = tally.get(s.suburb), shown = !hidden.includes(s.suburb);
            return (
              <li key={s.suburb}>
                <label className="grow">
                  <input type="checkbox" checked={shown} disabled={s.status !== "done"}
                    onChange={() => setHidden(shown ? [...hidden, s.suburb] : hidden.filter((x) => x !== s.suburb))} />
                  <span><strong>{suburbName(s.suburb)}</strong>
                    <span className="small muted">{s.status === "done"
                      ? t ? ` · ${Math.round((100 * t.fit) / Math.max(t.total, 1))}% fit, ${t.fit.toLocaleString()} of ${t.total.toLocaleString()}` : shown ? " · loading…" : ""
                      : s.status === "error" ? " · couldn't be analysed" : " · analysing…"}</span></span>
                </label>
                {s.status === "done" && shown && <button className="icon-btn" title={`Go to ${suburbName(s.suburb)}`} aria-label={`Go to ${suburbName(s.suburb)}`}
                  onClick={() => onGoTo(s.suburb)}><LocateFixed /></button>}
              </li>
            );
          })}
        </ul>
        <AddSuburb have={suburbs.map((s) => s.suburb)} suggestions={houseSuburbs} />
        <p className="small muted">Remove or re-run suburbs in <Link to="/settings#blocks">Settings</Link>.</p>
      </section>
    </>}
  </>;
}

/** A block you tapped: its address, whether it's one of your houses, whether it fits and why, the drop and measures. */
export function BlockSheet({ pfi, prefs, onClose }: { pfi: string; prefs: BlockPrefs; onClose: () => void }) {
  const q = useQuery({ queryKey: ["block", pfi], queryFn: () => api<Block>(`/api/blocks/${pfi}`) });
  const b = q.data;
  const where = b ? `${b.address ?? "No street address"}, ${suburbName(b.suburb)}` : "Block";
  return (
    <div className="sheet stack block-sheet">
      <div className="row">
        <strong className="grow">{where}</strong>
        <button className="link" onClick={onClose} aria-label="Close"><X /></button>
      </div>
      {q.isPending && <p className="small muted">Loading…</p>}
      {q.isError && <p className="error small">{(q.error as Error).message}</p>}
      {b && <>
        {b.tracked ? <Link to={`/p/${b.tracked.id}`} className="small">One of your houses: open it</Link>
          : <p className="small muted" style={{ margin: 0 }}>Not one of your houses.{b.addresses > 1 ? ` ${b.addresses} addresses on this block.` : ""}{" "}
            {b.address && <a href={`https://www.google.com/search?q=${encodeURIComponent(`${b.address} ${suburbName(b.suburb)} VIC`)}`} target="_blank" rel="noreferrer">
              Look it up <ExternalLink style={{ width: 12, height: 12, verticalAlign: -1 }} /></a>}</p>}
        <BlockFacts b={b} prefs={prefs} />
      </>}
    </div>
  );
}
