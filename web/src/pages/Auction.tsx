// Auction day (PLAN.md §5 Should): the limit shown large, a running bid log with one-tap increments,
// and a hard stop before any bid of ours goes over the walk-away limit.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { money, moneyRange, parseMoney } from "../format";

type Bid = { id: string; amount_aud: number; bidder: "us" | "other" | "vendor"; label: string | null; called_at: string };
type State = {
  campaign: { id: string; property_id: string; auction_at: string | null; outcome: string | null };
  address: string; walk_away: number | null; estimated_reserve: number | null;
  guide: { low_aud: number; high_aud: number } | null; max_affordable: number | null; bids: Bid[];
};
const LABELS = ["Bidder A", "Bidder B", "Bidder C", "Bidder D"];
const STEPS = [5_000, 10_000, 20_000, 50_000];
const timeFmt = new Intl.DateTimeFormat("en-AU", { hour: "numeric", minute: "2-digit", second: "2-digit" });

export default function Auction() {
  const { campaignId = "" } = useParams();
  const queryClient = useQueryClient();
  const key = ["auction", campaignId];
  const { data: s, isError } = useQuery({ queryKey: key, queryFn: () => api<State>(`/api/campaigns/${campaignId}/auction`), refetchInterval: 5000 });
  const [amount, setAmount] = useState("");
  const [bidder, setBidder] = useState<"us" | "other" | "vendor">("other");
  const [label, setLabel] = useState("Bidder A");
  const [overLimit, setOverLimit] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (isError) return <p className="error">Auction mode needs a connection.</p>;
  if (!s) return <p className="muted">Loading…</p>;
  const last = s.bids[s.bids.length - 1];
  const high = last?.amount_aud ?? 0;
  const limit = s.walk_away;
  const left = limit != null ? limit - high : null;
  const aud = parseMoney(amount);

  async function call(value: number, who = bidder, confirmOver = false) {
    setError(null);
    try {
      await api(`/api/campaigns/${campaignId}/bids`, { method: "POST", body: {
        amount_aud: value, bidder: who, label: who === "other" ? label : null, over_limit_ok: confirmOver } });
      setAmount("");
      setOverLimit(null);
      queryClient.invalidateQueries({ queryKey: key });
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 422 && (err.detail as { limit?: number })?.limit) setOverLimit(value);
      else setError(err.message);
    }
  }

  async function finish(outcome: string) {
    const body: Record<string, unknown> = { outcome };
    if (outcome === "passed_in") body.passed_in_bid_aud = high || null;
    else { body.sold_price_aud = high || null; body.bought_by_us = last?.bidder === "us"; }
    await api(`/api/campaigns/${campaignId}`, { method: "PATCH", body });
    queryClient.invalidateQueries({ queryKey: key });
    queryClient.invalidateQueries({ queryKey: ["overview"] });
  }

  return (
    <div className="auction stack" style={{ marginTop: 12 }}>
      <div className="row">
        <h1 className="grow" style={{ margin: 0 }}>{s.address}</h1>
        <Link to={`/p/${s.campaign.property_id}`}>House</Link>
      </div>
      <div className="grid3 auction-stats">
        <div><div className="muted small">Our limit</div><div className="big-number">{money(limit)}</div></div>
        <div><div className="muted small">Current bid</div><div className="big-number">{high ? money(high) : "—"}</div>
          {last && <div className="small">{last.bidder === "us" ? "Us" : last.bidder === "vendor" ? "Vendor bid" : last.label}</div>}</div>
        <div><div className="muted small">Room left</div>
          <div className={`big-number ${left != null && left < 0 ? "error" : ""}`}>{left == null ? "—" : money(Math.abs(left))}{left != null && left < 0 ? " over" : ""}</div></div>
      </div>
      <div className="small muted">
        Guide {moneyRange(s.guide?.low_aud ?? null, s.guide?.high_aud ?? null)}
        {s.estimated_reserve && ` · our reserve estimate ${money(s.estimated_reserve)}`}
        {s.max_affordable && ` · most we can afford ${money(s.max_affordable)}`}
      </div>

      {s.campaign.outcome ? (
        <div className="card">Recorded: {s.campaign.outcome.replace(/_/g, " ")}.</div>
      ) : (
        <div className="card stack">
          <div className="row">
            {(["other", "vendor", "us"] as const).map((b) => (
              <button key={b} className={`chip ${bidder === b ? "on" : ""}`} onClick={() => setBidder(b)}>
                {b === "us" ? "Us" : b === "vendor" ? "Vendor bid" : "Another bidder"}
              </button>
            ))}
          </div>
          {bidder === "other" && (
            <div className="row">
              {LABELS.map((l) => <button key={l} className={`chip ${label === l ? "on" : ""}`} onClick={() => setLabel(l)}>{l}</button>)}
            </div>
          )}
          <div className="grid2">
            {STEPS.map((step) => (
              <button key={step} className="step" disabled={!high} onClick={() => call(high + step)}>+{money(step)} → {money(high + step)}</button>
            ))}
          </div>
          <div className="row">
            <input className="grow" placeholder="Or type a bid, e.g. 1.05m" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <button className="primary" disabled={aud == null} onClick={() => aud && call(aud)}>Record</button>
          </div>
          {overLimit != null && (
            <div className="over-limit">
              <strong>{money(overLimit)} is over your limit of {money(limit)}.</strong>
              <div className="row">
                <button onClick={() => setOverLimit(null)}>Don't bid</button>
                <button className="danger" onClick={() => call(overLimit, "us", true)}>Record it anyway</button>
              </div>
            </div>
          )}
          {error && <p className="error">{error}</p>}
        </div>
      )}

      <div className="card">
        <h3>Bids</h3>
        {s.bids.length === 0 && <p className="small muted">No bids yet. Record the opening bid.</p>}
        <ul className="history">
          {[...s.bids].reverse().map((b) => (
            <li key={b.id} className="row small">
              <span className="grow"><strong>{money(b.amount_aud)}</strong> · {b.bidder === "us" ? "Us" : b.bidder === "vendor" ? "Vendor bid" : b.label ?? "Bidder"}</span>
              <span className="muted">{timeFmt.format(new Date(b.called_at))}</span>
              {!s.campaign.outcome && <button className="link" onClick={() => api(`/api/bids/${b.id}`, { method: "DELETE" }).then(() => queryClient.invalidateQueries({ queryKey: key }))}>✕</button>}
            </li>
          ))}
        </ul>
      </div>

      {!s.campaign.outcome && s.bids.length > 0 && (
        <div className="row">
          <button onClick={() => finish("sold_at_auction")}>Sold at {money(high)}</button>
          <button onClick={() => finish("passed_in")}>Passed in at {money(high)}</button>
        </div>
      )}
    </div>
  );
}
