import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import AddressSearch from "../AddressSearch";
import { api, ApiError, PROPERTY_TYPES, type Address, type BuildStatus, type PropertyType, type SaleMethod } from "../api";
import { fromLocalInput, LABEL, parseMoney, toLocalInput } from "../format";
import { CaptureReview, defaultChoices, ExistingUpdate, extrasFor, listingNotes, type Capture, type Choices } from "../listing/Capture";

const EMPTY: Address = { unit: "", street_number: "", street: "", suburb: "", postcode: "", plan_number: "", lot_number: "" };
const blankToNull = (v: string | null) => (v && v.trim() ? v.trim() : null);
const count = (v: string) => (v.trim() === "" ? null : Number(v));
// "652", "652 m2", "1,200m²" or "0.25 ha" -> square metres
const area = (v: string): number | null => {
  const s = v.trim().toLowerCase().replace(/,/g, "");
  if (!s) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(ha|hectares?|acres?|m2|m²|sqm)?$/);
  if (!m) return NaN;
  const n = parseFloat(m[1]) * (m[2]?.startsWith("ha") || m[2]?.startsWith("hect") ? 10_000 : m[2]?.startsWith("acre") ? 4046.86 : 1);
  return Math.round(n);
};

export default function QuickAdd() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [paste, setPaste] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [addr, setAddr] = useState<Address>(EMPTY);
  const [gnafPid, setGnafPid] = useState<string | null>(null);
  const [byLot, setByLot] = useState(false);
  const [type, setType] = useState<PropertyType>("house");
  const [build, setBuild] = useState<BuildStatus>("established");
  const [beds, setBeds] = useState("");
  const [baths, setBaths] = useState("");
  const [cars, setCars] = useState("");
  const [land, setLand] = useState("");
  const [building, setBuilding] = useState("");
  const [method, setMethod] = useState<SaleMethod | "">("");  // "Not listed yet" until a listing or the person says otherwise
  const [saleAt, setSaleAt] = useState("");
  const [url, setUrl] = useState("");
  const [low, setLow] = useState("");
  const [high, setHigh] = useState("");

  // Typing over a picked address means it may no longer be that G-NAF address.
  const [params] = useSearchParams();
  const [importUrl, setImportUrl] = useState("");
  const [importMsg, setImportMsg] = useState<string | null>(null);

  // What the listing said (bookmarklet or pasted link), and which extras to keep.
  const [capture, setCapture] = useState<Capture | null>(null);
  const [choices, setChoices] = useState<Choices | null>(null);

  async function applyPrefill(p: Capture) {
    setCapture(p);
    setChoices(defaultChoices(p));
    if (p.existing_property_id) { setImportMsg(null); return; }
    const filled: string[] = [];
    const parts = p.address_parts;
    if (parts?.street && parts.suburb) {
      const next = { ...EMPTY, unit: parts.unit ?? "", street_number: parts.street_number ?? "", street: parts.street,
                     suburb: parts.suburb, postcode: parts.postcode ?? "" };
      setAddr(next);
      setGnafPid(await gnafMatch(next));
      filled.push("address");
    } else if (p.address) {
      try {
        const parsed = await api<Address>(`/api/address/parse?text=${encodeURIComponent(p.address)}`);
        const next = { ...EMPTY, ...Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, v ?? ""])) } as Address;
        setAddr(next);
        setGnafPid(await gnafMatch(next));
        filled.push("address");
      } catch { setPaste(p.address); }
    }
    if (p.property_type) { setType(p.property_type); filled.push("type"); }
    if (p.beds != null) { setBeds(String(p.beds)); filled.push("beds"); }
    if (p.baths != null) { setBaths(String(p.baths)); filled.push("baths"); }
    if (p.car_spaces != null) { setCars(String(p.car_spaces)); filled.push("cars"); }
    if (p.land_m2 != null) { setLand(String(p.land_m2)); filled.push("land"); }
    if (p.building_m2 != null) { setBuilding(String(p.building_m2)); filled.push("building"); }
    if (p.sale_method) { setMethod(p.sale_method); filled.push("sale method"); }
    const at = p.sale_method === "auction" ? p.auction_at : p.sale_method === "eoi" ? p.eoi_closes_at : null;
    if (at) { setSaleAt(toLocalInput(at)); filled.push(p.sale_method === "auction" ? "auction date" : "EOI closing date"); }
    if (p.guide_low_aud) { setLow(String(p.guide_low_aud)); setHigh(String(p.guide_high_aud ?? p.guide_low_aud)); filled.push("price guide"); }
    if (p.url) setUrl(p.url);
    setImportMsg(filled.length ? `Filled in ${filled.join(", ")} from the listing. Check them before saving.` : "Couldn't find details on that page. Fill the form in.");
  }
  /** The G-NAF record for an address, when there's an exact match, so the house is pinned straight away. */
  async function gnafMatch(a: Address): Promise<string | null> {
    try {
      const q = [a.unit && `${a.unit}/`, a.street_number, a.street, a.suburb].filter(Boolean).join(" ").replace("/ ", "/");
      const hits = await api<{ pid: string; unit: string | null; street_number: string | null; street: string; suburb: string }[]>(
        `/api/address/search?q=${encodeURIComponent(q)}`);
      const same = (x: string | null | undefined, y: string | null | undefined) => (x ?? "").trim().toLowerCase() === (y ?? "").trim().toLowerCase();
      return hits.find((h) => same(h.street_number, a.street_number) && same(h.street, a.street) && same(h.suburb, a.suburb) && same(h.unit, a.unit))?.pid ?? null;
    } catch { return null; }
  }
  async function importLink() {
    setImportMsg("Reading the listing…");
    try {
      await applyPrefill(await api<Capture>("/api/listing/prefill", { method: "POST", body: { url: importUrl.trim() } }));
    } catch (e) {
      setImportMsg((e as Error).message);
      setUrl(importUrl.trim());
    }
  }
  // Opened by the bookmarklet: wait for the listing page to hand over its HTML.
  useEffect(() => {
    if (!params.get("capture")) return;
    setImportMsg("Waiting for the listing page…");
    const onMessage = async (e: MessageEvent) => {
      if (e.data?.type !== "housetrack-capture") return;
      (e.source as Window | null)?.postMessage("housetrack-got-it", e.origin);
      window.removeEventListener("message", onMessage);
      try {
        const d = e.data;
        const str = (v: unknown) => (typeof v === "string" && v ? v : null);
        setImportMsg("Reading the listing…");
        await applyPrefill(await api<Capture>("/api/listing/parse", { method: "POST", body: {
          url: d.url, html: str(d.html) ?? "", next_data: str(d.next_data), argonaut: str(d.argonaut), text: str(d.text),
          image: str(d.image) && /^https?:\/\//.test(d.image) ? d.image : null } }));
      } catch (err) {
        setImportMsg((err as Error).message);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k: keyof Address) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setAddr({ ...addr, [k]: e.target.value });
    setGnafPid(null);
  };

  async function split() {
    setPasteError(null);
    try {
      const parsed = await api<Address>(`/api/address/parse?text=${encodeURIComponent(paste)}`);
      setAddr({ ...EMPTY, ...Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, v ?? ""])) } as Address);
      setByLot(false);
      setGnafPid(null);
    } catch (e) {
      setPasteError((e as Error).message);
    }
  }

  const lowAud = parseMoney(low);
  const highAud = parseMoney(high);
  const priceProblem = (low && lowAud == null) || (high && highAud == null) ? "Prices look like 1.2m, 950k or 1250000."
    : Number.isNaN(area(land)) || Number.isNaN(area(building)) ? "Check the areas." : null;

  const save = useMutation({
    mutationFn: () =>
      api<{ id: string }>("/api/properties", {
        method: "POST",
        body: {
          address: {
            unit: blankToNull(addr.unit),
            street_number: blankToNull(addr.street_number),
            street: blankToNull(addr.street),
            suburb: blankToNull(addr.suburb),
            postcode: blankToNull(addr.postcode),
            plan_number: byLot ? blankToNull(addr.plan_number) : null,
            lot_number: byLot ? blankToNull(addr.lot_number) : null,
          },
          gnaf_pid: gnafPid,
          property_type: type,
          build_status: build,
          beds: count(beds),
          baths: count(baths),
          car_spaces: count(cars),
          land_m2: area(land),
          building_m2: area(building),
          notes: capture && choices?.notes ? listingNotes(capture) : null,
          listing: capture && choices && !capture.existing_property_id ? extrasFor(capture, choices) : null,
          campaign: method
            ? {
                sale_method: method,
                auction_at: method === "auction" ? fromLocalInput(saleAt) : null,
                eoi_closes_at: method === "eoi" ? fromLocalInput(saleAt) : null,
                url: blankToNull(url),
                listed_on: capture?.listed_on ?? null,
                guide_low_aud: lowAud,
                guide_high_aud: highAud,
              }
            : null,
        },
      }),
    onSuccess: async ({ id }) => {
      for (const key of [["overview"], ["tags"]]) queryClient.invalidateQueries({ queryKey: key });
      navigate(`/p/${id}`);
    },
  });
  const err = save.error as ApiError | null;

  return (
    <div className="stack" style={{ marginTop: 12 }}>
      <h1>Add a house</h1>
      <p className="muted small">Paste a listing link to fill most of this in, or type the address. Only the address is needed; the rest can wait.</p>

      {capture?.existing_property_id && (
        <>
          <ExistingUpdate c={capture} />
          <p className="small muted">Not the same house? <button className="link" onClick={() => applyPrefill({ ...capture, existing_property_id: null })}>Add it as a new house</button></p>
        </>
      )}
      {!capture?.existing_property_id && <>

      <div className="card stack">
        <h2>From a listing</h2>
        <label>
          Listing link
          <div className="row" style={{ marginTop: 4 }}>
            <input className="grow" type="url" placeholder="https://www.domain.com.au/…" value={importUrl} onChange={(e) => setImportUrl(e.target.value)} />
            <button disabled={!/^https?:\/\//.test(importUrl)} onClick={importLink}>Import</button>
          </div>
        </label>
        {importMsg && <p className="small muted">{importMsg}</p>}
      </div>

      {capture && choices && !capture.existing_property_id && <CaptureReview c={capture} ch={choices} set={setChoices} />}

      <div className="card stack">
        <h2>Address</h2>
        <label>
          Find the address
          <AddressSearch onPick={(hit) => {
            setAddr({ ...EMPTY, unit: hit.unit ?? "", street_number: hit.street_number ?? "", street: hit.street ?? "",
                      suburb: hit.suburb, postcode: hit.postcode });
            setGnafPid(hit.pid);
            setByLot(false);
          }} />
        </label>
        {gnafPid && <p className="small muted">Matched to the national address file, so it gets pinned on the map straight away.</p>}
        <label>
          Or paste one from a listing
          <div className="row" style={{ marginTop: 4 }}>
            <input className="grow" placeholder="3/12 Smith St, Box Hill VIC 3128" value={paste} onChange={(e) => setPaste(e.target.value)} />
            <button onClick={split} disabled={!paste.trim()}>Split</button>
          </div>
        </label>
        {pasteError && <p className="error small">{pasteError}</p>}

        <label className="check">
          <input type="checkbox" checked={byLot} onChange={(e) => setByLot(e.target.checked)} />
          No street number yet (off the plan): use plan and lot
        </label>
        {byLot && (
          <div className="grid2">
            <label>Plan number<input placeholder="PS812345" value={addr.plan_number ?? ""} onChange={set("plan_number")} /></label>
            <label>Lot<input value={addr.lot_number ?? ""} onChange={set("lot_number")} /></label>
          </div>
        )}
        <div className="grid3">
          <label>Unit<input value={addr.unit ?? ""} onChange={set("unit")} /></label>
          <label>Number<input value={addr.street_number ?? ""} onChange={set("street_number")} /></label>
          <label>Postcode<input inputMode="numeric" maxLength={4} value={addr.postcode ?? ""} onChange={set("postcode")} /></label>
        </div>
        <label>Street<input placeholder="Smith Street" value={addr.street ?? ""} onChange={set("street")} /></label>
        <label>Suburb<input value={addr.suburb ?? ""} onChange={set("suburb")} /></label>
      </div>

      <div className="card stack">
        <h2>The house</h2>
        <div className="grid2">
          <label>
            Type
            <select value={type} onChange={(e) => setType(e.target.value as PropertyType)}>
              {PROPERTY_TYPES.map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
            </select>
          </label>
          <label>
            Build
            <select value={build} onChange={(e) => setBuild(e.target.value as BuildStatus)}>
              <option value="established">Established</option>
              <option value="off_the_plan">Off the plan</option>
              <option value="under_construction">Under construction</option>
            </select>
          </label>
        </div>
        <div className="grid3">
          <label>Beds<input inputMode="numeric" value={beds} onChange={(e) => setBeds(e.target.value)} /></label>
          <label>Baths<input inputMode="numeric" value={baths} onChange={(e) => setBaths(e.target.value)} /></label>
          <label>Cars<input inputMode="numeric" value={cars} onChange={(e) => setCars(e.target.value)} /></label>
        </div>
        <div className="grid2">
          <label>Land area (m² or ha)<input inputMode="decimal" placeholder="e.g. 652" value={land} onChange={(e) => setLand(e.target.value)} /></label>
          <label>Building area (m²)<input inputMode="decimal" value={building} onChange={(e) => setBuilding(e.target.value)} /></label>
        </div>
        {(Number.isNaN(area(land)) || Number.isNaN(area(building))) && <p className="error small">Areas look like 652, 652 m² or 0.25 ha.</p>}
        {/^\d+(\.\d+)?$/.test(land.trim()) && Number(land) > 0 && Number(land) < 50 && (
          <p className="small tone-warn">{land.trim()} m² is tiny. For acres or hectares, type “{land.trim()} acres” or “{land.trim()} ha”.</p>
        )}
      </div>

      <div className="card stack">
        <h2>The sale</h2>
        <label>
          Sale method
          <select value={method} onChange={(e) => setMethod(e.target.value as SaleMethod | "")}>
            <option value="">Not listed yet</option>
            {(["auction", "eoi", "private_sale", "other"] as const).map((m) => <option key={m} value={m}>{LABEL.method[m]}</option>)}
          </select>
        </label>
        {(method === "auction" || method === "eoi") && (
          <label>
            {method === "auction" ? "Auction date and time" : "EOI closes"}
            <input type="datetime-local" value={saleAt} onChange={(e) => setSaleAt(e.target.value)} />
          </label>
        )}
        {method && (
          <>
            <label>Listing link<input type="url" placeholder="https://www.domain.com.au/…" value={url} onChange={(e) => setUrl(e.target.value)} /></label>
            <div className="grid2">
              <label>Price guide from<input placeholder="1.2m" value={low} onChange={(e) => setLow(e.target.value)} /></label>
              <label>to<input placeholder="1.3m" value={high} onChange={(e) => setHigh(e.target.value)} /></label>
            </div>
            {priceProblem && <p className="error small">{priceProblem}</p>}
          </>
        )}
      </div>

      {err && (
        <p className="error">
          {err.message}{" "}
          {err.existingPropertyId && <Link to={`/p/${err.existingPropertyId}`}>Open it</Link>}
        </p>
      )}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <Link to="/"><button>Cancel</button></Link>
        <button className="primary" style={{ minWidth: 160 }} disabled={save.isPending || !!priceProblem} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save house"}
        </button>
      </div>
      </>}
    </div>
  );
}
