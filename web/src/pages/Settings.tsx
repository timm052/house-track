import Notifications from "../Notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api, ApiError, type Person } from "../api";
import { usePeople, usePersons } from "../people";
import { money, parseMoney } from "../format";
import { CriteriaSettings } from "./Decide";
import ConfirmButton from "../ConfirmButton";
import { LIVE, Live, OfflineNote } from "../live";
import { AddSuburb, PrefsEditor, samePrefs, suburbName, useBlockPrefs, useBlockSuburbs, type BlockPrefs } from "../blocks";
import type { OverviewRow } from "../overview/columns";

export default function Settings() {
  const queryClient = useQueryClient();
  const persons = usePersons(true);
  const [name, setName] = useState("");
  const [colour, setColour] = useState("#2ca02c");

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["persons"] });
  const add = useMutation({
    mutationFn: () => api<Person>("/api/persons", { method: "POST", body: { display_name: name.trim(), colour } }),
    onSuccess: () => { setName(""); refresh(); },
  });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<Person> }) => api(`/api/persons/${id}`, { method: "PATCH", body }),
    onSuccess: refresh,
  });
  const { me } = usePeople();
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/persons/${id}`, { method: "DELETE" }),
    // Their verdicts and areas are gone, and credits changed hands: refresh everything that shows them.
    onSuccess: () => queryClient.invalidateQueries(),
  });

  // A link to a section (Settings → Blocks, the browser buttons): go to it once the page has drawn.
  const { hash } = useLocation();
  useEffect(() => {
    if (!hash) return;
    const t = window.setTimeout(() => document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView({ block: "start" }), 250);
    return () => window.clearTimeout(t);
  }, [hash]);

  return (
    <div style={{ marginTop: 12 }}>
      <h1>Settings</h1>
      <p className="small muted">Shared with the household. Stations and places are in <Link to="/places">Places</Link>.</p>
      <OfflineNote queries={[persons]} />
      <Notifications />
      <PhoneAdding />
      <Bookmarklets />
      <div className="card stack">
        <h2>People</h2>
        <Live queries={[persons]}>
        {persons.data?.map((p) => (
          <div key={p.id} className="row">
            <input type="color" aria-label="Colour" value={p.colour} style={{ width: 56, padding: 4 }}
              onChange={(e) => patch.mutate({ id: p.id, body: { colour: e.target.value } })} />
            <span className="grow" style={{ opacity: p.active ? 1 : 0.5 }}>{p.display_name}</span>
            <button className="link" onClick={() => patch.mutate({ id: p.id, body: { active: !p.active } })}>
              {p.active ? "Deactivate" : "Reactivate"}
            </button>
            {p.id !== me?.id && (
              <ConfirmButton label="Delete" yes={`Delete ${p.display_name}`} onConfirm={() => remove.mutate(p.id)}
                question={<>Their verdicts, scores and map areas will be deleted. Houses and notes they added move to you. This can't be undone.</>} />
            )}
          </div>
        ))}
        <div className="row">
          <input type="color" aria-label="Colour" value={colour} style={{ width: 56, padding: 4 }} onChange={(e) => setColour(e.target.value)} />
          <input className="grow" placeholder="Add a person" value={name} onChange={(e) => setName(e.target.value)} />
          <button disabled={!name.trim() || add.isPending} onClick={() => add.mutate()}>Add</button>
        </div>
        </Live>
        <p className="small muted" style={{ margin: 0 }}>Deactivate hides someone but keeps their verdicts. Delete removes them for good.</p>
        {(add.error || patch.error || remove.error) && <p className="error">{((add.error || patch.error || remove.error) as Error).message}</p>}
      </div>

      <MoneySettings />
      <LayerSettings />
      <BlockSettings />
      <CriteriaSettings />
      <TagSettings />
    </div>
  );
}

type CostSettings = { cash_aud: number; loan_preapproval_aud: number; loan_expiry: string | null; first_home_buyer: boolean;
                      principal_residence: boolean; conveyancing_aud: number; inspections_aud: number; other_aud: number };

/** Budget and fixed costs for the cost calculator and the highest affordable bid (milestone 4). */
function MoneySettings() {
  const queryClient = useQueryClient();
  const costs = useQuery({ queryKey: ["costs"], queryFn: () => api<{ settings: CostSettings; max_bid: number | null }>("/api/costs"), ...LIVE });
  const data = costs.data;
  const [f, setF] = useState<Record<string, string | boolean> | null>(null);
  const s = data?.settings;
  const form = f ?? (s ? {
    cash: String(s.cash_aud || ""), loan: String(s.loan_preapproval_aud || ""), expiry: s.loan_expiry ?? "", fhb: s.first_home_buyer,
    ppr: s.principal_residence, conv: String(s.conveyancing_aud), insp: String(s.inspections_aud), other: String(s.other_aud),
  } : null);
  const save = useMutation({
    mutationFn: () => api("/api/costs", { method: "PUT", body: {
      cash_aud: parseMoney(String(form!.cash)) ?? 0, loan_preapproval_aud: parseMoney(String(form!.loan)) ?? 0,
      loan_expiry: form!.expiry || null, first_home_buyer: form!.fhb, principal_residence: form!.ppr,
      conveyancing_aud: parseMoney(String(form!.conv)) ?? 0, inspections_aud: parseMoney(String(form!.insp)) ?? 0,
      other_aud: parseMoney(String(form!.other)) ?? 0 } }),
    onSuccess: () => { setF(null); queryClient.invalidateQueries({ queryKey: ["costs"] }); },
  });
  if (!form) return null;
  const text = (k: string, label: string) => (
    <label>{label}<input value={String(form[k])} onChange={(e) => setF({ ...form, [k]: e.target.value })} /></label>
  );
  const expiring = s?.loan_expiry && new Date(s.loan_expiry).getTime() - Date.now() < 30 * 86400_000;
  return (
    <div className="card stack">
      <h2>Budget</h2>
      <p className="small muted">Used for total costs and your maximum bid. Stamp duty uses Victorian rates.</p>
      <Live queries={[costs]}>
      <div className="grid2">{text("cash", "Cash for the purchase")}{text("loan", "Loan pre-approval")}</div>
      <label>Pre-approval expires<input type="date" value={String(form.expiry)} onChange={(e) => setF({ ...form, expiry: e.target.value })} /></label>
      {expiring && <p className="small error">Your pre-approval expires within 30 days.</p>}
      <label className="check"><input type="checkbox" checked={!!form.fhb} onChange={(e) => setF({ ...form, fhb: e.target.checked })} /> First home buyers</label>
      <label className="check"><input type="checkbox" checked={!!form.ppr} onChange={(e) => setF({ ...form, ppr: e.target.checked })} /> Principal place of residence</label>
      <div className="grid3">{text("conv", "Conveyancing")}{text("insp", "Inspections")}{text("other", "Other fees")}</div>
      <button className="primary" onClick={() => save.mutate()} disabled={save.isPending}>Save budget</button>
      </Live>
      {data?.max_bid != null && <p>Maximum bid, after costs: <strong>{money(data.max_bid)}</strong></p>}
    </div>
  );
}

type Layer = { code: string; title: string; effect: "info" | "soft_warn" | "hard_exclude"; data_as_of: string | null };

/** Per-layer effect for the whole household (milestone 5): e.g. make floodways exclude houses outright. */
/** Blocks (the map's Blocks mode): the suburbs analysed and the household's block preferences, which decide what the
 *  Houses list, the Grid and each house's page count as fitting. */
function BlockSettings() {
  const queryClient = useQueryClient();
  const suburbs = useBlockSuburbs();
  const saved = useBlockPrefs();
  const overview = useQuery({ queryKey: ["overview"], queryFn: () => api<{ rows: OverviewRow[] }>("/api/overview") });
  const [draft, setDraft] = useState<BlockPrefs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const prefs = draft ?? saved.data;
  const changed = draft != null && !samePrefs(draft, saved.data);
  const counts = new Map<string, number>();
  for (const r of overview.data?.rows ?? []) if (r.suburb) counts.set(String(r.suburb), (counts.get(String(r.suburb)) ?? 0) + 1);
  const suggestions = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([x]) => x);
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); }
    queryClient.invalidateQueries({ queryKey: ["block-suburbs"] });
  };
  async function save() {
    setError(null);
    try {
      await api("/api/blocks/prefs", { method: "PUT", body: draft });
      setDraft(null);
      for (const key of [["block-prefs"], ["overview"], ["block"], ["property-block"]]) queryClient.invalidateQueries({ queryKey: key });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const when = new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric" });
  return (
    <div className="card stack" id="blocks">
      <h2>Blocks</h2>
      <p className="small muted">Every property's block in the suburbs below is measured from Victoria's open map data: its size, frontage,
        shape, slope and which way it falls. The map's <Link to="/map">Blocks</Link> mode shows them all, including houses that aren't for
        sale. Re-run a suburb now and then to pick up new subdivisions.</p>
      <Live queries={[suburbs]}>
        {(suburbs.data ?? []).length > 0 && (
          <ul className="bk-settings-list">
            {suburbs.data!.map((x) => (
              <li key={x.suburb}>
                <span className="grow"><strong>{suburbName(x.suburb)}</strong>
                  <span className="small muted"> · {x.status === "done" ? `${(x.blocks ?? 0).toLocaleString()} blocks, ${x.analysed_at ? when.format(new Date(x.analysed_at)) : ""}`
                    : x.status === "error" ? "couldn't be analysed" : x.status === "running" ? "analysing now…" : "waiting to be analysed…"}</span>
                  {x.status === "error" && x.error && <span className="small error" style={{ display: "block" }}>{x.error}</span>}</span>
                {(x.status === "done" || x.status === "error") && <button className="link" onClick={() => act(() => api(`/api/blocks/suburbs/${encodeURIComponent(x.suburb)}/refresh`, { method: "POST" }))}>
                  {x.status === "error" ? "Try again" : "Re-run"}</button>}
                <ConfirmButton label="Remove" yes={`Remove ${suburbName(x.suburb)}`} question="Its blocks leave the map, and its houses lose their block details."
                  onConfirm={() => act(() => api(`/api/blocks/suburbs/${encodeURIComponent(x.suburb)}`, { method: "DELETE" }))} />
              </li>
            ))}
          </ul>
        )}
        <AddSuburb have={(suburbs.data ?? []).map((x) => x.suburb)} suggestions={suggestions} />
      </Live>
      <h3 style={{ margin: "8px 0 0" }}>The household's block preferences</h3>
      <p className="small muted" style={{ margin: 0 }}>Used to mark houses that fit on the Houses list, the Grid and each house's page. The map can try
        others out first.</p>
      {prefs && <PrefsEditor value={prefs} onChange={setDraft} full />}
      {error && <p className="error small">{error}</p>}
      {changed && (
        <div className="row">
          <button className="primary" onClick={save} disabled={prefs!.max_m2 < prefs!.min_m2}>Save</button>
          <button className="link" onClick={() => setDraft(null)}>Cancel</button>
        </div>
      )}
    </div>
  );
}

function LayerSettings() {
  const queryClient = useQueryClient();
  const overlays = useQuery({ queryKey: ["overlays"], queryFn: () => api<Layer[]>("/api/overlays"), ...LIVE });
  const data = overlays.data ?? [];
  if (!data.length) return null;
  const set = (code: string, effect: string) =>
    api(`/api/overlays/${code}`, { method: "PATCH", body: { effect } }).then(() => {
      queryClient.invalidateQueries({ queryKey: ["overlays"] });
      queryClient.invalidateQueries({ queryKey: ["overview"] });
      queryClient.invalidateQueries({ queryKey: ["map"] });
    });
  return (
    <div className="card stack">
      <h2>Schools and planning layers</h2>
      <p className="small muted">Choose how each layer affects the houses inside it.</p>
      <Live queries={[overlays]}>
      {data.map((l) => (
        <div key={l.code} className="row">
          <span className="grow small">{l.title}{l.data_as_of && <span className="muted"> · {l.data_as_of}</span>}</span>
          <select value={l.effect} onChange={(e) => set(l.code, e.target.value)} style={{ width: "auto" }} aria-label={`Effect of ${l.title}`}>
            <option value="info">Show</option>
            <option value="soft_warn">Warn</option>
            <option value="hard_exclude">Exclude</option>
          </select>
        </div>
      ))}
      </Live>
    </div>
  );
}

// ─── browser buttons (bookmarklets) ───────────────────────────────────
// Bump when the code changes, so people know to drag the buttons again.
const BOOKMARKLETS_UPDATED = "1 Oct 2026 (v4)";

/** + House Track: listing capture for pages the server can't fetch (PLAN.md D12). Runs in your own browser on the
 *  listing page, opens House Track's Add page and hands it the page's own data (Domain's __NEXT_DATA__,
 *  realestate.com.au's page data, any other page-state object, the head's Open Graph tags, structured-data blocks and
 *  the visible text). Works on property.com.au pages too, as far as they give up their data. */
function captureCode(origin: string) {
  return `javascript:(()=>{const o=${JSON.stringify(origin)};const w=window.open(o+'/add?capture=1','housetrack');if(!w){alert('Your browser blocked the House Track window. Allow pop-ups for this site, then click + House Track again.');return}` +
    `const q=s=>document.querySelector(s),m=q('meta[property="og:image"]'),n=q('#__NEXT_DATA__');let a=null,g=null;` +
    `try{a=window.ArgonautExchange?JSON.stringify(window.ArgonautExchange).slice(0,3900000):null}catch(e){}` +
    `if(!a||a.length<200){try{a=[...document.scripts].map(s=>s.textContent).filter(t=>t&&t.includes('ArgonautExchange')).join('\\n/*--script--*/\\n').slice(0,3900000)||null}catch(e){}}` +
    `try{const k=window.__INITIAL_STATE__||window.__PRELOADED_STATE__||window.__APOLLO_STATE__||window.__NUXT__||window.__remixContext;g=k?JSON.stringify(k).slice(0,3900000):null}catch(e){}` +
    `const ld=[...document.querySelectorAll('script[type="application/ld+json"]')].map(s=>s.outerHTML).join('');` +
    `const d={type:'housetrack-capture',v:3,url:location.href,image:m&&m.content||null,next_data:n?n.textContent.slice(0,3900000):null,` +
    `argonaut:a,page_state:g,html:(document.head.outerHTML+ld).slice(0,2900000),text:document.body.innerText.slice(0,390000)};` +
    `const t=setInterval(()=>{try{w.postMessage(d,o)}catch(e){}},400);` +
    `addEventListener('message',e=>{if(e.origin===o&&e.data==='housetrack-got-it')clearInterval(t)});setTimeout(()=>clearInterval(t),20000)})()`;
}

/** ⟳ Refresh from Domain (see pages/Refresh.tsx for the conversation it has with House Track). Clicked on any
 *  domain.com.au page: opens /refresh, says hello so that page can check where it came from, then loads each listing
 *  it's given from Domain, a few seconds apart, and passes the page data back. */
function refreshCode(origin: string) {
  return `javascript:(()=>{const o=${JSON.stringify(origin)};if(!/(^|\\.)domain\\.com\\.au$/.test(location.hostname)){alert('Open any page on domain.com.au first, then click Refresh from Domain.');return}` +
    `const w=window.open(o+'/refresh?run=1','housetrack-refresh');if(!w){alert('Your browser blocked the House Track window. Allow pop-ups for domain.com.au, then click Refresh from Domain again.');return}let busy=false;` +
    `const hi=setInterval(()=>{try{w.postMessage({type:'ht-hello'},o)}catch(x){}},500);setTimeout(()=>clearInterval(hi),30000);` +
    `addEventListener('message',async e=>{if(e.origin!==o||!e.data||e.data.type!=='ht-targets'||busy)return;busy=true;clearInterval(hi);` +
    `for(const t of e.data.targets){const r={type:'ht-page',id:t.id,url:t.url};` +
    `try{const x=await fetch(t.url,{credentials:'include'});r.status=x.status;const h=await x.text();` +
    `const m=h.match(/<script id="__NEXT_DATA__"[^>]*>([\\s\\S]*?)<\\/script>/);r.next_data=m?m[1]:null;` +
    `const g=h.match(/property="og:image" content="([^"]+)"/);r.image=g?g[1]:null}catch(err){r.error=String(err)}` +
    `w.postMessage(r,o);await new Promise(s=>setTimeout(s,e.data.gap||4000))}w.postMessage({type:'ht-done'},o)})})()`;
}

/** A bookmarklet: drag it to the bookmarks bar, or copy its code to make the bookmark by hand. */
function BookmarkletButton({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const [hint, setHint] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(code); setCopied("yes"); } catch { setCopied("no"); }
    setTimeout(() => setCopied(null), 2500);
  }
  return (
    <div className="row">
      {/* React blocks javascript: links in JSX, so the href is set directly. Clicking it here does nothing. */}
      <a className="bookmarklet" title="Drag to your bookmarks bar" draggable
        ref={(el) => { el?.setAttribute("href", code); }} onClick={(e) => { e.preventDefault(); setHint(true); }}>{label}</a>
      <button className="small-btn" onClick={copy}>{copied === "yes" ? "Copied ✓" : copied === "no" ? "Couldn't copy" : "Copy code"}</button>
      {hint && <p className="small tone-warn" style={{ flexBasis: "100%", margin: 0 }}>
        Drag this to your bookmarks bar, then click it there on a
        {label.includes("Refresh") ? " Domain page" : " Domain, realestate.com.au or property.com.au listing"}.</p>}
    </div>
  );
}

/** Used by the /refresh page's instructions too. */
export function refreshBookmarklet() {
  return <BookmarkletButton code={refreshCode(location.origin)} label="⟳ Refresh from Domain" />;
}

/** Adding a house from a phone: the Share menu (Android, once the app is installed) or an Apple Shortcut (iPhone),
 *  both opening /add with the listing's link. Phone browsers make bookmarklets awkward, so this is the phone path. */
/** A line to copy into the phone's shortcut (tap Copy, or select it by hand). */
function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch { /* select it by hand */ }
  }
  return (
    <div className="row" style={{ marginTop: 4 }}>
      <code className="grow" style={{ wordBreak: "break-all" }}>{text}</code>
      <button className="small-btn" onClick={copy}>{copied ? "Copied ✓" : "Copy"}</button>
    </div>
  );
}

function PhoneAdding() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const android = /Android/.test(navigator.userAgent);
  const { me } = usePeople();
  return (
    <div className="card stack" id="phone">
      <h2>Adding houses from your phone</h2>
      <p className="small" style={{ margin: 0 }}>
        Share a listing to House Track from the Domain or realestate.com.au app, or your browser. For realestate.com.au links,
        you enter the address.
      </p>
      {!ios && (
        <details open={android}>
          <summary><strong>Android</strong></summary>
          <ol className="small steps">
            <li>In Chrome, open House Track and tap <strong>⋮ → Add to Home screen → Install</strong>.</li>
            <li>On a listing, tap <strong>Share</strong> and choose <strong>House Track</strong>.</li>
          </ol>
          <p className="small muted" style={{ margin: 0 }}>Not in the Share menu? Open House Track once from the home screen, then try again.</p>
        </details>
      )}
      {!android && (
        <details open={ios}>
          <summary><strong>iPhone and iPad</strong></summary>
          <p className="small" style={{ margin: "6px 0" }}>
            On iPhone, use a shortcut. There are two; set up either or both.</p>
          <h3 className="small" style={{ margin: "8px 0 2px" }}>Add in the background</h3>
          <p className="small" style={{ margin: 0 }}>
            Adds the house in the background and shows a notification.</p>
          <ol className="small steps">
            <li>Open <strong>Shortcuts</strong>, tap <strong>+</strong>, and rename the shortcut <strong>Add to House Track</strong>.</li>
            <li>Tap the name, then <strong>Details</strong> (or <strong>ⓘ</strong>), and turn on <strong>Show in Share Sheet</strong>. In
              the <em>Receive</em> block, choose <strong>URLs</strong>, <strong>Safari web pages</strong> and <strong>Text</strong>.</li>
            <li>Add <strong>Get URLs from Input</strong>.</li>
            <li>Add <strong>URL</strong> and enter this address:
              <CopyLine text={`${location.origin}/api/share`} /></li>
            <li>Add <strong>Get Contents of URL</strong>, tap <strong>Show More</strong>, and set:
              <ul>
                <li><strong>Method</strong>: POST</li>
                <li><strong>Headers</strong>: a header with key <code>X-Person-Id</code> and your ID as the value.
                  {me ? <CopyLine text={me.id} /> : <span className="muted"> Choose who you are first.</span>}</li>
                <li><strong>Request Body</strong>: JSON, with a <strong>Text</strong> field. Its key is <code>url</code> and its value is
                  the variable <strong>URLs</strong>.</li>
              </ul></li>
            <li>Add <strong>Get Dictionary Value</strong> and set it to get <code>message</code> from <strong>Contents of URL</strong>.</li>
            <li>Add <strong>Show Notification</strong> showing <strong>Dictionary Value</strong>, then tap <strong>Done</strong>.</li>
            <li>To use it, tap <strong>Share → Add to House Track</strong> on a listing. Allow it to connect the first time.</li>
          </ol>
          <h3 className="small" style={{ margin: "12px 0 2px" }}>Check it first</h3>
          <p className="small" style={{ margin: 0 }}>
            Opens the filled-in <strong>Add a house</strong> form to review before saving.</p>
          <ol className="small steps">
            <li>In <strong>Shortcuts</strong>, tap <strong>+</strong> and name it <strong>Check in House Track</strong>.</li>
            <li>Turn on <strong>Show in Share Sheet</strong> as above, with the same three input types.</li>
            <li>Add <strong>Get URLs from Input</strong>, then <strong>URL Encode</strong>.</li>
            <li>Add <strong>Text</strong> and enter this address. With the cursor at the end, tap <strong>URL Encoded Text</strong> above
              the keyboard so it follows <code>url=</code>:
              <CopyLine text={`${location.origin}/add?url=`} /></li>
            <li>Add <strong>Open URLs</strong>. It should read <em>Open Text</em>. Tap <strong>Done</strong>.</li>
            <li>To use it, tap <strong>Share → Check in House Track</strong> on a listing. It opens in your browser.</li>
          </ol>
          <p className="small muted" style={{ margin: 0 }}>Both need Tailscale. Each person uses their own ID.</p>
        </details>
      )}
    </div>
  );
}

function Bookmarklets() {
  const origin = location.origin;
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <div className="card stack" id="bookmarklets">
      <h2>Browser buttons</h2>
      <p className="small" style={{ margin: 0 }}>
        Add and update houses from Domain, realestate.com.au and property.com.au in a desktop browser.
      </p>
      <ol className="small steps">
        <li>Show the bookmarks bar with <kbd>{mac ? "⌘" : "Ctrl"}</kbd> + <kbd>Shift</kbd> + <kbd>B</kbd>.</li>
        <li>Drag each button below onto it.</li>
      </ol>

      <div className="bm-item">
        <BookmarkletButton code={captureCode(origin)} label="+ House Track" />
        <p className="small muted">
          Click it on a listing to add the house, or to update one you already track.
        </p>
      </div>
      <div className="bm-item">
        <BookmarkletButton code={refreshCode(origin)} label="⟳ Refresh from Domain" />
        <p className="small muted">
          Click it on any Domain page to update all active houses. <Link to="/refresh">Details</Link>
        </p>
      </div>

      <details>
        <summary className="small">On a phone browser instead</summary>
        <p className="small" style={{ margin: "6px 0" }}>
          Not every phone browser supports these.</p>
        <ol className="small steps">
          <li>Tap <strong>Copy code</strong> next to a button.</li>
          <li><strong>Android Chrome:</strong> bookmark any page, edit the bookmark and paste the code as its URL. To use it, type its
            name in the address bar on a listing and tap it.</li>
          <li><strong>iPhone Safari:</strong> bookmark any page, edit it in <strong>Bookmarks</strong> and paste the code as its address.
            To use it, open Bookmarks on a listing and tap it.</li>
        </ol>
      </details>
      <details>
        <summary className="small">Can't drag them? Add them by hand</summary>
        <ol className="small steps">
          <li>Click <strong>Copy code</strong> next to a button.</li>
          <li>Right-click the bookmarks bar and choose <strong>Add page…</strong> (Chrome, Edge) or <strong>Add Bookmark…</strong> (Firefox).</li>
          <li>Name it, paste the code into the <strong>URL</strong> box and save.</li>
        </ol>
      </details>
      <p className="small muted" style={{ margin: 0 }}>
        Buttons updated {BOOKMARKLETS_UPDATED}. Replace older copies.
      </p>
    </div>
  );
}

type TagRow = { id: string; name: string; colour: string; houses: number };

/** Tags are shared: rename, recolour, merge or delete them here (houses get them on their page, in the grid,
 *  or from a listing's suggestions). */
function TagSettings() {
  const queryClient = useQueryClient();
  const tags = useQuery({ queryKey: ["tags"], queryFn: () => api<TagRow[]>("/api/tags"), ...LIVE });
  const data = tags.data ?? [];
  const [msg, setMsg] = useState<{ id: string; text: string; mergeInto?: string; name?: string } | null>(null);
  const refresh = () => ["tags", "overview", "property"].forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
  async function patch(t: TagRow, body: Record<string, unknown>) {
    setMsg(null);
    try {
      await api(`/api/tags/${t.id}`, { method: "PATCH", body });
      refresh();
    } catch (e) {
      const d = e instanceof ApiError ? (e.detail as { merge_into?: string }) : undefined;
      setMsg({ id: t.id, text: (e as Error).message, mergeInto: d?.merge_into, name: body.name as string | undefined });
    }
  }
  return (
    <div className="card stack">
      <h2>Tags</h2>
      {data.length === 0 && <p className="small muted" style={{ margin: 0 }}>No tags yet. Add them on a house's page or in the Grid.</p>}
      <Live queries={[tags]}>
      {data.map((t) => (
        <div key={t.id}>
          <div className="row">
            <input type="color" value={t.colour} aria-label={`Colour of ${t.name}`} style={{ width: 40, height: 36, padding: 2 }}
              onChange={(e) => patch(t, { colour: e.target.value.toLowerCase() })} />
            <input className="grow" defaultValue={t.name} aria-label="Tag name" key={t.name}
              onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== t.name) patch(t, { name: v }); }}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
            <span className="small muted" style={{ minWidth: 70 }}>{t.houses} {t.houses === 1 ? "house" : "houses"}</span>
            <ConfirmButton className="small-btn" label="Delete" yes={`Delete #${t.name}`}
              question={`Remove it from ${t.houses} ${t.houses === 1 ? "house" : "houses"}?`}
              onConfirm={() => api(`/api/tags/${t.id}`, { method: "DELETE" }).then(refresh)} />
          </div>
          {msg?.id === t.id && (
            <p className="small error" style={{ margin: "4px 0 0" }}>{msg.text}{" "}
              {msg.mergeInto && <button className="link" onClick={() => patch(t, { name: msg.name, merge: true })}>Merge #{t.name} into #{msg.name}</button>}
            </p>
          )}
        </div>
      ))}
      </Live>
    </div>
  );
}
