// Weekly refresh from Domain (PLAN.md D12). The "Refresh from Domain" bookmarklet, clicked on any domain.com.au
// page, opens this page. The two talk by postMessage:
//   Domain tab  → here: "ht-hello" (so we learn and check its origin)
//   here        → Domain tab: the houses to check and the gap between them
//   Domain tab  → here: each listing's page data, loaded from Domain in your own browser, then "ht-done"
// Each listing goes to /api/listing/refresh, which applies what changed and says what it was.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { when } from "../format";
import { refreshBookmarklet } from "./Settings";

type Target = { id: string; url: string; address: string; last_checked_at: string | null };
type Result = { changes: string[]; flag?: string | null; error?: string; price_text?: string | null };
type Row = Target & { state: "waiting" | "checking" | "done"; result?: Result };

const GAP_MS = 4000;
const isDomain = (origin: string) => { try { return /(^|\.)domain\.com\.au$/.test(new URL(origin).hostname); } catch { return false; } };

export default function Refresh() {
  const queryClient = useQueryClient();
  const targets = useQuery({ queryKey: ["refresh-targets"], queryFn: () => api<Target[]>("/api/listing/targets") });
  const [rows, setRows] = useState<Row[] | null>(null);
  const [finished, setFinished] = useState(false);
  const started = useRef(false);
  const domainOrigin = useRef<string | null>(null);
  // Launched by the bookmarklet (?run=1). Some browsers hide window.opener across sites, so don't rely on it.
  const [params] = useSearchParams();
  const opened = params.get("run") === "1";
  const [waitedTooLong, setWaitedTooLong] = useState(false);
  useEffect(() => {
    if (!opened) return;
    const t = window.setTimeout(() => { if (!started.current) setWaitedTooLong(true); }, 8000);
    return () => window.clearTimeout(t);
  }, [opened]);

  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      const d = e.data;
      if (!d || typeof d !== "object" || !isDomain(e.origin)) return;
      if (d.type === "ht-hello" && !started.current) {
        started.current = true;
        setWaitedTooLong(false);
        domainOrigin.current = e.origin;
        const list = await api<Target[]>("/api/listing/targets");
        setRows(list.map((t) => ({ ...t, state: "waiting" })));
        (e.source as Window | null)?.postMessage({ type: "ht-targets", gap: GAP_MS, targets: list.map((t) => ({ id: t.id, url: t.url })) }, e.origin);
        if (list.length === 0) setFinished(true);
        return;
      }
      if (e.origin !== domainOrigin.current) return;
      if (d.type === "ht-page" && typeof d.id === "string") {
        setRows((rs) => rs && rs.map((r) => (r.id === d.id ? { ...r, state: "checking" } : r)));
        let result: Result;
        try {
          result = await api<Result>("/api/listing/refresh", { method: "POST", body: {
            property_id: d.id, url: d.url, status_code: typeof d.status === "number" ? d.status : null,
            next_data: typeof d.next_data === "string" ? d.next_data : null, image: typeof d.image === "string" ? d.image : null } });
          if (d.error) result = { changes: [], error: `Couldn't load it from Domain: ${d.error}` };
        } catch (err) {
          result = { changes: [], error: (err as Error).message };
        }
        setRows((rs) => rs && rs.map((r) => (r.id === d.id ? { ...r, state: "done", result } : r)));
      }
      if (d.type === "ht-done") {
        setFinished(true);
        for (const key of [["overview"], ["refresh-targets"]]) queryClient.invalidateQueries({ queryKey: key });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [queryClient]);

  const done = rows?.filter((r) => r.state === "done") ?? [];
  const changed = done.filter((r) => r.result?.changes.length);
  const flagged = done.filter((r) => r.result?.flag);
  const failed = done.filter((r) => r.result?.error);

  return (
    <div style={{ marginTop: 12 }}>
      <h1>Refresh from Domain</h1>
      {!opened && (
        <div className="card stack">
          <p style={{ margin: 0 }}>Checks every active house's Domain listing and records what changed: new price guides, auction or EOI dates,
            inspection times, agents and the Statement of Information. Photos and tags are left alone.</p>
          <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
            <li>Drag the button below to your bookmarks bar (once).</li>
            <li>Open any page on domain.com.au and click it. This page opens and shows progress.</li>
            <li>Leave the Domain tab open until it finishes: it loads one listing every {GAP_MS / 1000} seconds.</li>
          </ol>
          <div>{refreshBookmarklet()}</div>
          <p className="small muted" style={{ margin: 0 }}>It runs in your own browser at the pace you'd click through the listings yourself.
            Keep it to your shortlist (it checks at most 40 houses, least recently checked first). Domain can change their pages or block this at any time.</p>
        </div>
      )}

      {rows == null && waitedTooLong && (
        <div className="card stack" style={{ borderColor: "var(--maybe)" }}>
          <h2>The Domain tab hasn't answered</h2>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            <li>Keep the Domain tab open: it does the loading.</li>
            <li>Drag the button from Settings again. Older copies of the button don't talk to this page.</li>
            <li>Click it from the bookmarks bar while you're on domain.com.au, not from inside House Track.</li>
          </ul>
          <div>{refreshBookmarklet()}</div>
        </div>
      )}

      {rows == null && (
        <div className="card">
          <h2>{opened ? "Connecting to the Domain tab…" : "Houses it will check"}</h2>
          {targets.data?.length === 0 && <p className="small muted">No active houses have a Domain link on a live campaign.</p>}
          <ul className="history small">
            {targets.data?.map((t) => (
              <li key={t.id}><Link to={`/p/${t.id}`}>{t.address}</Link>
                <span className="muted"> · {t.last_checked_at ? `checked ${when(t.last_checked_at)}` : "never checked"}</span></li>
            ))}
          </ul>
        </div>
      )}

      {rows != null && (
        <>
          <div className="stat-grid">
            <div className="stat"><div className="muted small">Checked</div><div className="stat-value">{done.length} of {rows.length}</div>
              {!finished && <div className="muted small">about {Math.ceil(((rows.length - done.length) * GAP_MS) / 60000)} min to go</div>}</div>
            <div className="stat"><div className="muted small">Changed</div><div className="stat-value">{changed.length}</div></div>
            <div className="stat"><div className="muted small">Need a look</div><div className={`stat-value ${flagged.length ? "tone-warn" : ""}`}>{flagged.length}</div></div>
            <div className="stat"><div className="muted small">Couldn't read</div><div className={`stat-value ${failed.length ? "tone-bad" : ""}`}>{failed.length}</div></div>
          </div>
          {finished && <p className="small">{rows.length === 0 ? "Nothing to check." : "Finished. You can close the Domain tab."}</p>}
          <div className="card">
            <ul className="refresh-list">
              {rows.map((r) => (
                <li key={r.id} className={r.state}>
                  <span className="refresh-state" aria-hidden>{r.state === "waiting" ? "○" : r.state === "checking" ? "◌" : r.result?.error ? "✕" : r.result?.flag ? "!" : r.result?.changes.length ? "●" : "✓"}</span>
                  <div className="grow">
                    <Link to={`/p/${r.id}`}>{r.address}</Link>
                    {r.state === "checking" && <span className="muted small"> · reading…</span>}
                    {r.result && (
                      <div className="small">
                        {r.result.changes.length > 0 ? <strong>{r.result.changes.join(" · ")}</strong> : !r.result.error && !r.result.flag && <span className="muted">No change</span>}
                        {r.result.flag && <div className="tone-warn">{r.result.flag}</div>}
                        {r.result.error && <div className="tone-bad">{r.result.error}</div>}
                        {r.result.price_text && <div className="muted">Listing says: {r.result.price_text}</div>}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
