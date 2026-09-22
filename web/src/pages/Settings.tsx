import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type Person, type Settings as SettingsT } from "../api";
import { usePersons } from "../people";
import { money, parseMoney } from "../format";
import { CriteriaSettings } from "./Decide";

export default function Settings() {
  const queryClient = useQueryClient();
  const persons = usePersons();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api<SettingsT>("/api/settings") });
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
  const walk = useMutation({
    mutationFn: (v: number) => api("/api/settings/walk_limit_min", { method: "PUT", body: { value: v } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
  });

  return (
    <div style={{ marginTop: 12 }}>
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
          </div>
        ))}
        <div className="row">
          <input type="color" aria-label="Colour" value={colour} style={{ width: 56, padding: 4 }} onChange={(e) => setColour(e.target.value)} />
          <input className="grow" placeholder="Add a person" value={name} onChange={(e) => setName(e.target.value)} />
          <button disabled={!name.trim() || add.isPending} onClick={() => add.mutate()}>Add</button>
        </div>
        {(add.error || patch.error) && <p className="error">{((add.error || patch.error) as Error).message}</p>}
      </div>

      <div className="card stack">
        <h2>Stations</h2>
        {settings.data && (
          <label>
            Walking limit (minutes). Each house shows its nearest station, plus others within this walk.
            <input inputMode="numeric" defaultValue={settings.data.walk_limit_min}
              onBlur={(e) => { const v = Number(e.target.value); if (v >= 1 && v <= 120) walk.mutate(v); }} />
          </label>
        )}
        <Link to="/places"><button>Choose stations and places</button></Link>
      </div>
      <MoneySettings />
      <LayerSettings />
      <CriteriaSettings />
      <Bookmarklet />
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

/** Listing capture for pages the server can't fetch (PLAN.md D12). Runs in your own browser on the
 *  listing page, opens House Track's Add page and hands it the page as you see it. Fragile by design. */
function Bookmarklet() {
  const origin = location.origin;
  const code = `javascript:(()=>{const o=${JSON.stringify(origin)};const w=window.open(o+'/add?capture=1','housetrack');` +
    `const d={type:'housetrack-capture',url:location.href,html:document.documentElement.outerHTML.slice(0,2900000)};` +
    `const t=setInterval(()=>{try{w.postMessage(d,o)}catch(e){}},400);` +
    `addEventListener('message',e=>{if(e.origin===o&&e.data==='housetrack-got-it')clearInterval(t)});setTimeout(()=>clearInterval(t),20000)})()`;
  return (
    <div className="card stack">
      <h2>Add from a listing page</h2>
      <p className="small muted">
        Drag this button to your browser's bookmarks bar. On a Domain or realestate.com.au listing, click it: House Track opens with the
        address, rooms and price guide filled in for you to check. It reads the page as you see it, so it can break when the sites change.
      </p>
      {/* React blocks javascript: links in JSX, so the href is set directly. */}
      <a className="button-like" ref={(el) => { el?.setAttribute("href", code); }} onClick={(e) => e.preventDefault()}>
        + House Track
      </a>
    </div>
  );
}
