import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, type Person } from "../api";
import { usePeople, usePersons } from "../people";
import { money, parseMoney } from "../format";
import { CriteriaSettings } from "./Decide";
import ConfirmButton from "../ConfirmButton";

export default function Settings() {
  const queryClient = useQueryClient();
  const persons = usePersons();
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

  return (
    <div style={{ marginTop: 12 }}>
      <h1>Settings</h1>
      <p className="small muted">Shared by everyone in the household. <a href="#bookmarklets">Browser buttons</a> · Travel times and stations are under <Link to="/places">Places</Link>.</p>
      <Bookmarklets />
      <div className="card stack">
        <h2>People</h2>
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
                question={<>Their verdicts, scores, map areas and attendance go. Houses, prices and notes they entered stay, credited to
                  you ({me?.display_name ?? "you"}). This can't be undone.</>} />
            )}
          </div>
        ))}
        <div className="row">
          <input type="color" aria-label="Colour" value={colour} style={{ width: 56, padding: 4 }} onChange={(e) => setColour(e.target.value)} />
          <input className="grow" placeholder="Add a person" value={name} onChange={(e) => setName(e.target.value)} />
          <button disabled={!name.trim() || add.isPending} onClick={() => add.mutate()}>Add</button>
        </div>
        <p className="small muted" style={{ margin: 0 }}>Deactivate hides someone but keeps their verdicts. Delete removes them for good.</p>
        {(add.error || patch.error || remove.error) && <p className="error">{((add.error || patch.error || remove.error) as Error).message}</p>}
      </div>

      <MoneySettings />
      <LayerSettings />
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
  const { data } = useQuery({ queryKey: ["costs"], queryFn: () => api<{ settings: CostSettings; max_bid: number | null }>("/api/costs") });
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
      <p className="small muted">Used to show all-in costs and the most you can bid. Stamp duty uses Victoria's rates (check them with the State Revenue Office before relying on a figure).</p>
      <div className="grid2">{text("cash", "Cash for the purchase")}{text("loan", "Loan pre-approval")}</div>
      <label>Pre-approval expires<input type="date" value={String(form.expiry)} onChange={(e) => setF({ ...form, expiry: e.target.value })} /></label>
      {expiring && <p className="small error">The pre-approval expires within 30 days.</p>}
      <label className="check"><input type="checkbox" checked={!!form.fhb} onChange={(e) => setF({ ...form, fhb: e.target.checked })} /> First home buyers</label>
      <label className="check"><input type="checkbox" checked={!!form.ppr} onChange={(e) => setF({ ...form, ppr: e.target.checked })} /> We'll live in it (principal residence)</label>
      <div className="grid3">{text("conv", "Conveyancing")}{text("insp", "Inspections")}{text("other", "Other fees")}</div>
      <button className="primary" onClick={() => save.mutate()} disabled={save.isPending}>Save budget</button>
      {data?.max_bid != null && <p>Most you can bid, all costs included: <strong>{money(data.max_bid)}</strong></p>}
    </div>
  );
}

type Layer = { code: string; title: string; effect: "info" | "soft_warn" | "hard_exclude"; data_as_of: string | null };

/** Per-layer effect for the whole household (milestone 5): e.g. make floodways exclude houses outright. */
function LayerSettings() {
  const queryClient = useQueryClient();
  const { data = [] } = useQuery({ queryKey: ["overlays"], queryFn: () => api<Layer[]>("/api/overlays") });
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
      <p className="small muted">What a house inside each layer means for both of you. Refresh the data with the setup job.</p>
      {data.map((l) => (
        <div key={l.code} className="row">
          <span className="grow small">{l.title}{l.data_as_of && <span className="muted"> · {l.data_as_of}</span>}</span>
          <select value={l.effect} onChange={(e) => set(l.code, e.target.value)} style={{ width: "auto" }} aria-label={`Effect of ${l.title}`}>
            <option value="info">Just show it</option>
            <option value="soft_warn">Warn</option>
            <option value="hard_exclude">Exclude</option>
          </select>
        </div>
      ))}
    </div>
  );
}

// ─── browser buttons (bookmarklets) ───────────────────────────────────
// Bump when the code changes, so people know to drag the buttons again.
const BOOKMARKLETS_UPDATED = "23 Sept 2026 (v3)";

/** + House Track: listing capture for pages the server can't fetch (PLAN.md D12). Runs in your own browser on the
 *  listing page, opens House Track's Add page and hands it the page's own data (Domain's __NEXT_DATA__,
 *  realestate.com.au's page data, the head's Open Graph tags, structured-data blocks and the visible text). */
function captureCode(origin: string) {
  return `javascript:(()=>{const o=${JSON.stringify(origin)};const w=window.open(o+'/add?capture=1','housetrack');if(!w){alert('Your browser blocked the House Track window. Allow pop-ups for this site, then click + House Track again.');return}` +
    `const q=s=>document.querySelector(s),m=q('meta[property="og:image"]'),n=q('#__NEXT_DATA__');let a=null;` +
    `try{a=window.ArgonautExchange?JSON.stringify(window.ArgonautExchange).slice(0,3900000):null}catch(e){}` +
    `const ld=[...document.querySelectorAll('script[type="application/ld+json"]')].map(s=>s.outerHTML).join('');` +
    `const d={type:'housetrack-capture',v:2,url:location.href,image:m&&m.content||null,next_data:n?n.textContent.slice(0,3900000):null,` +
    `argonaut:a,html:(document.head.outerHTML+ld).slice(0,2900000),text:document.body.innerText.slice(0,390000)};` +
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
      <a className="bookmarklet" title="Drag me to your bookmarks bar" draggable
        ref={(el) => { el?.setAttribute("href", code); }} onClick={(e) => { e.preventDefault(); setHint(true); }}>{label}</a>
      <button className="small-btn" onClick={copy}>{copied === "yes" ? "Copied ✓" : copied === "no" ? "Couldn't copy" : "Copy code"}</button>
      {hint && <p className="small tone-warn" style={{ flexBasis: "100%", margin: 0 }}>
        This button does nothing here. Drag it to your bookmarks bar, then click it there while you're on a
        {label.includes("Refresh") ? " Domain page" : " Domain or realestate.com.au listing"}.</p>}
    </div>
  );
}

/** Used by the /refresh page's instructions too. */
export function refreshBookmarklet() {
  return <BookmarkletButton code={refreshCode(location.origin)} label="⟳ Refresh from Domain" />;
}

function Bookmarklets() {
  const origin = location.origin;
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <div className="card stack" id="bookmarklets">
      <h2>Browser buttons</h2>
      <p className="small" style={{ margin: 0 }}>
        Two buttons for your browser's bookmarks bar, for adding and updating houses straight from Domain and realestate.com.au.
        They work in Chrome, Edge, Firefox and Safari on a computer.
      </p>
      <ol className="small steps">
        <li>Show the bookmarks bar: press <kbd>{mac ? "⌘" : "Ctrl"}</kbd> + <kbd>Shift</kbd> + <kbd>B</kbd>.</li>
        <li>Drag each button below onto the bookmarks bar.</li>
      </ol>

      <div className="bm-item">
        <BookmarkletButton code={captureCode(origin)} label="+ House Track" />
        <p className="small muted">
          On a listing, click it to add the house: the address, rooms, land, sale method and date, and price guide are filled in, with
          the photos, agents, inspection times, Statement of Information and suggested tags to tick. On a listing you already track, it
          shows what's changed and updates the house.
        </p>
      </div>
      <div className="bm-item">
        <BookmarkletButton code={refreshCode(origin)} label="⟳ Refresh from Domain" />
        <p className="small muted">
          Once a week, open any Domain page and click it. It checks every active house's listing a few seconds apart and records new price
          guides, dates, inspection times and agents. <Link to="/refresh">See what it will check</Link>
        </p>
      </div>

      <details>
        <summary className="small">Can't drag them? Add them by hand</summary>
        <ol className="small steps">
          <li>Click <strong>Copy code</strong> next to a button.</li>
          <li>Right-click the bookmarks bar and choose <strong>Add page…</strong> (Chrome, Edge) or <strong>Add Bookmark…</strong> (Firefox).</li>
          <li>Name it (for example “+ House Track”), paste the code into the <strong>URL</strong> box, and save.</li>
        </ol>
      </details>
      <p className="small muted" style={{ margin: 0 }}>
        Buttons last updated {BOOKMARKLETS_UPDATED}. If you added them before then, delete the old ones and drag these again.
        They read the listing as your browser shows it, so they can break when the sites change.
      </p>
    </div>
  );
}

type TagRow = { id: string; name: string; colour: string; houses: number };

/** Tags are shared: rename, recolour, merge or delete them here (houses get them on their page, in the grid,
 *  or from a listing's suggestions). */
function TagSettings() {
  const queryClient = useQueryClient();
  const { data = [] } = useQuery({ queryKey: ["tags"], queryFn: () => api<TagRow[]>("/api/tags") });
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
    </div>
  );
}
