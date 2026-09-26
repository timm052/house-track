import type { GuideSource, JudgementKind, Outcome, SaleMethod, Stage, Stance, Status } from "./api";

/** "1.2m", "950k", "$1,250,000", "1250000" → whole dollars; null if it isn't a price. */
export function parseMoney(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/[$,\s]/g, "");
  if (!s) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)(k|m)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]) * (m[2] === "m" ? 1_000_000 : m[2] === "k" ? 1_000 : 1);
  return n > 0 ? Math.round(n) : null;
}

/** $1.25m / $950k style, for dense lists. */
export function money(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(3).replace(/\.?0+$/, "")}m`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${n}`;
}

export function moneyRange(low: number | null, high: number | null): string {
  if (low == null) return "No guide";
  return high == null || high === low ? money(low) : `${money(low)}–${money(high)}`;
}

/** How a sale went against the first price guide (over its top, within it, or under its bottom) and against what
 *  we thought the house was worth: `amount` is the difference ("$195k over"), `rest` what it's against. */
export function soldAgainst(sold: number, firstLow: number | null, firstHigh: number | null, ours: number | null) {
  const out: { amount: string | null; rest: string; tone: "" | "bad" | "good" }[] = [];
  if (firstLow != null) {
    const high = firstHigh ?? firstLow, guide = `the first guide of ${moneyRange(firstLow, high)}`;
    if (sold > high) out.push({ amount: `${money(sold - high)} over`, rest: guide, tone: "bad" });
    else if (sold < firstLow) out.push({ amount: `${money(firstLow - sold)} under`, rest: guide, tone: "good" });
    else out.push({ amount: null, rest: `${high === firstLow ? "at" : "within"} ${guide}`, tone: "" });
  }
  if (ours != null) {
    const d = sold - ours, est = `our ${money(ours)} estimate`;
    out.push(d === 0 ? { amount: null, rest: `at ${est}`, tone: "" }
      : { amount: `${money(Math.abs(d))} ${d > 0 ? "over" : "under"}`, rest: est, tone: d > 0 ? "bad" : "good" });
  }
  return out;
}

/** An outcome that means the house sold. */
export const isSold = (outcome: unknown) => typeof outcome === "string" && outcome.startsWith("sold");

/** Its sale is over and someone else has it (sold, withdrawn or gone; a pass-in can still sell): whatever our status,
 *  it fades and sinks to the bottom of the list. */
export const saleEnded = (outcome: unknown, boughtByUs: unknown) =>
  typeof outcome === "string" && outcome !== "passed_in" && !boughtByUs;

const dateTime = new Intl.DateTimeFormat("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const dateOnly = new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric" });

export const when = (iso: string | null) => (iso ? dateTime.format(new Date(iso)) : "");
export const day = (iso: string | null) => (iso ? dateOnly.format(new Date(iso)) : "");

/** Whole calendar days from a date (YYYY-MM-DD) to another, or to today. */
export function daysSince(from: string, to?: string | null): number {
  const utc = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const [y, m, d] = from.slice(0, 10).split("-").map(Number);
  const end = to ? (() => { const [ty, tm, td] = to.slice(0, 10).split("-").map(Number); return Date.UTC(ty, tm - 1, td); })() : utc(new Date());
  return Math.max(0, Math.round((end - Date.UTC(y, m - 1, d)) / 86_400_000));
}

/** <input type="datetime-local"> value ⇄ ISO with offset. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export const fromLocalInput = (v: string): string | null => (v ? new Date(v).toISOString() : null);

export const LABEL = {
  status: {
    watching: "Watching", interested: "Interested", shortlisted: "Shortlisted", offering: "Offering",
    bought: "Bought", missed_out: "Missed out", ruled_out: "Ruled out",
  } satisfies Record<Status, string>,
  method: { auction: "Auction", eoi: "EOI", private_sale: "Private sale", other: "Other" } satisfies Record<SaleMethod, string>,
  stage: { pre_inspection: "Before inspecting", post_inspection: "After inspecting" } satisfies Record<Stage, string>,
  stageShort: { pre_inspection: "Pre", post_inspection: "Post" } satisfies Record<Stage, string>,
  stance: { yes: "Yes", maybe: "Maybe", no: "No" } satisfies Record<Stance, string>,
  outcome: {
    sold_prior: "Sold prior", sold_at_auction: "Sold at auction", sold_after_auction: "Sold after auction",
    sold: "Sold", passed_in: "Passed in", withdrawn: "Withdrawn", disappeared: "Listing disappeared",
  } satisfies Record<Outcome, string>,
  // Victorian labels for the generic database values (region pack, PLAN.md D9).
  guideSource: {
    price_statement: "Statement of Information", advertised: "Advertised", agent_verbal: "Agent (verbal)", other: "Other",
  } satisfies Record<GuideSource, string>,
  judgement: {
    estimated_reserve: "Our reserve estimate", expected_sale: "What we think it's worth", walk_away: "Our max",
  } satisfies Record<JudgementKind, string>,
};

export function saleWhen(p: { sale_method: SaleMethod | null; auction_at: string | null; eoi_closes_at: string | null }): string {
  if (p.sale_method === "auction" && p.auction_at) return `Auction ${when(p.auction_at)}`;
  if (p.sale_method === "eoi" && p.eoi_closes_at) return `EOI closes ${when(p.eoi_closes_at)}`;
  return p.sale_method ? LABEL.method[p.sale_method] : "Not listed";
}

export function rooms(p: { beds: number | null; baths: number | null; car_spaces: number | null }): string {
  const parts = [
    p.beds != null && `${p.beds} bed`,
    p.baths != null && `${p.baths} bath`,
    p.car_spaces != null && `${p.car_spaces} car`,
  ].filter(Boolean);
  return parts.join(" · ");
}

export const minutes = (s: number | null) => (s == null ? "" : `${Math.max(1, Math.round(s / 60))} min`);
export const km = (m: number | null) => (m == null ? "" : m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);

/** Land area: square metres, or hectares for acreage. */
export const landArea = (m2: number) =>
  m2 >= 10_000 ? `${(m2 / 10_000).toLocaleString(undefined, { maximumFractionDigits: 2 })} ha` : `${m2.toLocaleString()} m²`;

/** Inspection types: the choices when adding one. */
export const INSPECTION_KINDS: Record<string, string> = {
  open: "Open for inspection", private: "Private inspection", second_look: "Second look", building_pest: "Building & pest",
  display_suite: "Display suite", pre_settlement: "Pre-settlement", other: "Other",
};
/** Anything on the calendar: an inspection's type, or an auction or EOI closing. */
export const EVENT_LABEL: Record<string, string> = { ...INSPECTION_KINDS, other: "Inspection", auction: "Auction", eoi: "EOI closes" };

/** The street part of an address, as the server writes it: "3/12 Smith Street", or "Lot 45 Smith Street" off the plan. */
export function streetLine(a: { unit?: string | null; street_number?: string | null; street?: string | null; lot_number?: string | null }): string {
  if (a.street_number) return `${a.unit ? `${a.unit}/` : ""}${a.street_number} ${a.street ?? ""}`.trim();
  return `Lot ${a.lot_number ?? "?"} ${a.street ?? ""}`.trim();
}
