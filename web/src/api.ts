// Typed client for the House Track API. Types mirror api/app/schemas.py and the row shapes the routes return.

export type Person = { id: string; display_name: string; colour: string; active: boolean };
export type Stage = "pre_inspection" | "post_inspection";
export type Stance = "yes" | "maybe" | "no";
export type SaleMethod = "auction" | "eoi" | "private_sale" | "other";
export type Status = (typeof STATUSES)[number];
export type Outcome = (typeof OUTCOMES)[number];
export type PropertyType = (typeof PROPERTY_TYPES)[number];
export type BuildStatus = "established" | "off_the_plan" | "under_construction";
export type GuideSource = "price_statement" | "advertised" | "agent_verbal" | "other";
export type JudgementKind = "estimated_reserve" | "expected_sale" | "walk_away";

export const STATUSES = ["watching", "inspecting", "shortlisted", "bidding", "rejected", "lost", "withdrawn", "bought"] as const;
export const OUTCOMES = ["sold_prior", "sold_at_auction", "sold_after_auction", "sold", "passed_in", "withdrawn", "disappeared"] as const;
export const PROPERTY_TYPES = ["house", "townhouse", "unit", "apartment", "land", "other"] as const;

export type Address = {
  unit: string | null;
  street_number: string | null;
  street: string | null;
  suburb: string | null;
  postcode: string | null;
  plan_number: string | null;
  lot_number: string | null;
};

type PropertyBase = Address & {
  id: string;
  address: string;
  gnaf_pid: string | null;
  property_type: PropertyType;
  build_status: BuildStatus;
  beds: number | null;
  baths: number | null;
  car_spaces: number | null;
  land_m2: number | null;
  building_m2: number | null;
  owners_corp_fees_aud_pa: number | null;
  council_rates_aud_pa: number | null;
  notes: string | null;
  lat: number | null;
  lon: number | null;
  manual_pin: boolean;
  geocode_source: "gnaf" | "nominatim" | "listing" | null;
  geocode_confidence: number | null;
  geocode_status: "pending" | "done" | "no_match";
  status: Status;
};

export type PropertySummary = PropertyBase & {
  campaign_id: string | null;
  sale_method: SaleMethod | null;
  listed_on: string | null;
  auction_at: string | null;
  eoi_closes_at: string | null;
  outcome: Outcome | null;
  sold_price_aud: number | null;
  guide_low_aud: number | null;
  guide_high_aud: number | null;
  opinions: { person_id: string; stage: Stage; stance: Stance }[];
  nearest_station: string | null;
  nearest_station_walk_s: number | null;
  excluded: boolean;
  warned: boolean;
};

export type Opinion = {
  id: string;
  person_id: string;
  campaign_id: string | null;
  stage: Stage;
  stance: Stance;
  note: string | null;
  recorded_at: string;
  created_by: string;
};

export type Campaign = {
  id: string;
  continues_campaign_id: string | null;
  sale_method: SaleMethod;
  listed_on: string | null;
  auction_at: string | null;
  eoi_closes_at: string | null;
  outcome: Outcome | null;
  outcome_on: string | null;
  sold_price_aud: number | null;
  passed_in_bid_aud: number | null;
  bought_by_us: boolean;
  links: { id: string; portal: string; url: string; external_id: string | null }[];
  price_guides: {
    id: string; source: GuideSource; low_aud: number; high_aud: number;
    statement_suburb_median_aud: number | null; observed_at: string; note: string | null; created_by: string;
  }[];
  judgements: { id: string; kind: JudgementKind; amount_aud: number; note: string | null; created_at: string; created_by: string }[];
  agents: { id: string; name: string; mobile: string | null; email: string | null; is_lead: boolean; agency_name: string | null; office: string | null }[];
};

export type PropertyDetail = PropertyBase & {
  status_history: { id: string; status: Status; reason: string | null; occurred_at: string; created_by: string }[];
  opinions: Opinion[];
  campaigns: Campaign[];
  travel: Travel;
  inspections: import("./pages/PropertyExtras").Inspection[];
  attachments: import("./pages/PropertyExtras").Attachment[];
  overlays: { code: string; title: string; effect: "info" | "soft_warn" | "hard_exclude"; label: string }[];
};

export type Settings = { walk_limit_min: number };

// ─── acting person (profile picker) ───────────────────────────────────
const PERSON_KEY = "housetrack.person";

export function getActingPerson(): string | null {
  try {
    return localStorage.getItem(PERSON_KEY);
  } catch {
    return null;
  }
}

export function setActingPerson(id: string | null): void {
  try {
    if (id) localStorage.setItem(PERSON_KEY, id);
    else localStorage.removeItem(PERSON_KEY);
  } catch {
    /* private mode: the picker simply asks again next time */
  }
}

// ─── transport ────────────────────────────────────────────────────────
export class ApiError extends Error {
  constructor(public status: number, public detail: unknown) {
    super(typeof detail === "string" ? detail : (detail as { message?: string })?.message ?? `Request failed (${status})`);
  }
  get existingPropertyId(): string | null {
    return (this.detail as { existing_property_id?: string })?.existing_property_id ?? null;
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const person = getActingPerson();
  if (person) headers["X-Person-Id"] = person;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = data?.detail;
    // FastAPI validation errors arrive as a list; show the first message.
    if (Array.isArray(detail)) throw new ApiError(res.status, detail[0]?.msg?.replace(/^Value error, /, "") ?? "Invalid input");
    throw new ApiError(res.status, detail ?? res.statusText);
  }
  return data as T;
}

// ─── geography (milestone 2) ──────────────────────────────────────────
export type AreaKind = "hard_exclude" | "soft_warn";
export type Flag = { owner_id: string; kind: AreaKind; name: string };

export type MapProperty = {
  id: string; unit: string | null; street_number: string | null; street: string | null; suburb: string;
  plan_number: string | null; lot_number: string | null; manual_pin: boolean; status: Status;
  excluded: boolean; warned: boolean; reasons: string[]; others_flags: Flag[];
  opinions: { person_id: string; stage: Stage; stance: Stance }[];
  nearest_station: string | null; nearest_station_walk_s: number | null;
};
export type MapArea = { id: string; owner_id: string; name: string; kind: AreaKind; reason: string | null };
export type MapPlace = { id: string; kind: "station" | "destination"; name: string; person_id: string | null; station_osm_id: number | null; is_favourite: boolean };

type Feature<P, G = GeoJSON.Geometry> = { type: "Feature"; geometry: G; properties: P };
export type FC<P, G = GeoJSON.Geometry> = { type: "FeatureCollection"; features: Feature<P, G>[] };

export type MapData = {
  properties: FC<MapProperty, GeoJSON.Point>;
  areas: FC<MapArea, GeoJSON.MultiPolygon>;
  places: FC<MapPlace, GeoJSON.Point>;
  unpinned: number;
};

export type AddressHit = {
  pid: string; display: string; unit: string | null; street_number: string | null; street: string | null;
  suburb: string; postcode: string; lot_number: string | null; lon: number; lat: number;
};
export type StationHit = { osm_id: number; name: string; lon: number; lat: number; chosen: boolean };
export type Place = MapPlace & { lon: number; lat: number };

export type Travel = {
  stations: { place_id: string; name: string; distance_m: number; duration_s: number; is_nearest: boolean; within_limit: boolean }[];
  destinations: { place_id: string; name: string; person_id: string | null; walk_m: number | null; walk_s: number | null; drive_m: number | null; drive_s: number | null }[];
  pending: number;
};
