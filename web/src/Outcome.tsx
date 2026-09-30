// Recording how a sale ended, and keeping the house's status in step with it. Used on the house page and in
// the Houses page's "This week" panel (for houses whose sale date has passed or whose listing says it's over).
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, OUTCOMES, type Outcome, type SaleMethod, type Status } from "./api";
import { LABEL, parseMoney } from "./format";

/** The status a sale's end suggests, if any: bought when it's ours, sold when someone else got it while we
 *  were offering. Otherwise none: watching a house to see its result doesn't make it lost, and a withdrawal or
 *  pass-in is the sale's news, not ours. */
export function outcomeStatus(outcome: Outcome | null | undefined, boughtByUs: boolean, status: Status): Status | null {
  if (!outcome?.startsWith("sold")) return null;
  return boughtByUs ? "bought" : status === "offering" ? "missed_out" : null;
}

/** An outcome recorded that the status hasn't caught up with. */
export const statusOutOfStep = (outcome: Outcome | null | undefined, boughtByUs: boolean, status: Status) => {
  const want = outcomeStatus(outcome, boughtByUs, status);
  return want != null && status !== want;
};

/** Set the status the outcome implies, checked against the status the person saw (latestStatusId). */
export async function applyOutcomeStatus(propertyId: string, status: Status, latestStatusId: string | null) {
  await api(`/api/properties/${propertyId}/status`, { method: "POST", body: {
    status, reason: "Sale outcome recorded", check_latest: latestStatusId != null, expected_latest_id: latestStatusId } });
}

export function OutcomeForm({ propertyId, campaignId, saleMethod, status, latestStatusId, listingStatus, listingPriceText, onDone }: {
  propertyId: string; campaignId: string; saleMethod: SaleMethod; status: Status; latestStatusId: string | null;
  listingStatus?: string | null; listingPriceText?: string | null; onDone?: () => void;
}) {
  const queryClient = useQueryClient();
  const listedSold = (listingStatus ?? "").toLowerCase() === "sold";
  const [outcome, setOutcome] = useState<Outcome>(listedSold ? "sold" : saleMethod === "auction" ? "sold_at_auction" : "sold");
  // "Sold for $1,250,000" on the listing: offer that figure.
  const [price, setPrice] = useState(() => {
    const m = listingPriceText?.match(/\$[\d,.]+\s*[mk]?/i);
    return listedSold && m ? m[0].replace(/\s/g, "") : "";
  });
  const [ours, setOurs] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sold = outcome.startsWith("sold");
  const aud = parseMoney(price);
  const next = outcomeStatus(outcome, ours, status);
  const offerStatus = next != null && next !== status;
  const [alsoStatus, setAlsoStatus] = useState(true);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/campaigns/${campaignId}`, { method: "PATCH", body: {
        outcome, sold_price_aud: sold ? aud : null, passed_in_bid_aud: outcome === "passed_in" ? aud : null, bought_by_us: sold && ours } });
      if (offerStatus && alsoStatus && next) await applyOutcomeStatus(propertyId, next, latestStatusId);
      for (const key of [["property", propertyId], ["overview"], ["refresh-targets"]]) queryClient.invalidateQueries({ queryKey: key });
      onDone?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack outcome-form">
      {listingPriceText && <div className="small"><span className="muted">The listing says:</span> <strong>{listingPriceText}</strong></div>}
      <div className="grid2">
        <select value={outcome} onChange={(e) => setOutcome(e.target.value as Outcome)} aria-label="Outcome">
          {OUTCOMES.map((o) => <option key={o} value={o}>{LABEL.outcome[o]}</option>)}
        </select>
        {(sold || (outcome === "passed_in" && saleMethod === "auction")) && (
          <input value={price} onChange={(e) => setPrice(e.target.value)} aria-label={sold ? "Sold price" : "Passed in at"}
            placeholder={sold ? "Sold price (blank if undisclosed)" : "Passed in at"} />
        )}
      </div>
      {sold && <label className="check"><input type="checkbox" checked={ours} onChange={(e) => setOurs(e.target.checked)} /> We bought it</label>}
      {offerStatus && next && (
        <label className="check"><input type="checkbox" checked={alsoStatus} onChange={(e) => setAlsoStatus(e.target.checked)} />
          Also set the status to {LABEL.status[next]}</label>
      )}
      {error && <p className="error small" style={{ margin: 0 }}>{error}</p>}
      <div><button className="primary" disabled={busy || (price !== "" && aud == null)} onClick={save}>{busy ? "Saving…" : "Save outcome"}</button></div>
    </div>
  );
}
