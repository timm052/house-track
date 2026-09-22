import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import AddressSearch from "../AddressSearch";
import { api, ApiError, PROPERTY_TYPES, type Address, type BuildStatus, type PropertyType, type SaleMethod } from "../api";
import { fromLocalInput, LABEL, parseMoney } from "../format";

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
  const [method, setMethod] = useState<SaleMethod | "">("auction");
  const [saleAt, setSaleAt] = useState("");
  const [url, setUrl] = useState("");
  const [low, setLow] = useState("");
  const [high, setHigh] = useState("");

  // Typing over a picked address means it may no longer be that G-NAF address.
  const [params] = useSearchParams();
  const [importUrl, setImportUrl] = useState("");
  const [importMsg, setImportMsg] = useState<string | null>(null);

  type Prefill = { url: string | null; address: string | null; beds: number | null; baths: number | null; car_spaces: number | null; land_m2: number | null;
                   sale_method: SaleMethod | null; guide_low_aud: number | null; guide_high_aud: number | null };
  async function applyPrefill(p: Prefill) {
    const filled: string[] = [];
    if (p.address) {
      try {
        const parsed = await api<Address>(`/api/address/parse?text=${encodeURIComponent(p.address)}`);
        setAddr({ ...EMPTY, ...Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, v ?? ""])) } as Address);
        setGnafPid(null);
        filled.push("address");
      } catch { setPaste(p.address); }
    }
    if (p.beds != null) { setBeds(String(p.beds)); filled.push("beds"); }
    if (p.baths != null) { setBaths(String(p.baths)); filled.push("baths"); }
    if (p.car_spaces != null) { setCars(String(p.car_spaces)); filled.push("cars"); }
    if (p.land_m2 != null) { setLand(String(p.land_m2)); filled.push("land area"); }
    if (p.sale_method) { setMethod(p.sale_method); filled.push("sale method"); }
    if (p.guide_low_aud) { setLow(String(p.guide_low_aud)); setHigh(String(p.guide_high_aud ?? p.guide_low_aud)); filled.push("price guide"); }
    if (p.url) setUrl(p.url);
    setImportMsg(filled.length ? `Filled in ${filled.join(", ")} from the listing. Check them before saving.` : "Couldn't find details on that page. Fill the form in.");
  }
  async function importLink() {
    setImportMsg("Reading the listing…");
    try {
      await applyPrefill(await api<Prefill>("/api/listing/prefill", { method: "POST", body: { url: importUrl.trim() } }));
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
        await applyPrefill(await api<Prefill>("/api/listing/parse", { method: "POST", body: { url: e.data.url, html: e.data.html } }));
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
          campaign: method
            ? {
                sale_method: method,
                auction_at: method === "auction" ? fromLocalInput(saleAt) : null,
                eoi_closes_at: method === "eoi" ? fromLocalInput(saleAt) : null,
                url: blankToNull(url),
                guide_low_aud: lowAud,
                guide_high_aud: highAud,
              }
            : null,
        },
      }),
    onSuccess: ({ id }) => {
      queryClient.invalidateQueries({ queryKey: ["overview"] });
      navigate(`/p/${id}`);
    },
  });
  const err = save.error as ApiError | null;

  return (
    <div className="stack" style={{ marginTop: 12 }}>
      <h1>Add a house</h1>

      <div className="card stack">
        <label>
          Import from a listing link
          <div className="row" style={{ marginTop: 4 }}>
            <input className="grow" type="url" placeholder="https://www.domain.com.au/…" value={importUrl} onChange={(e) => setImportUrl(e.target.value)} />
            <button disabled={!/^https?:\/\//.test(importUrl)} onClick={importLink}>Import</button>
          </div>
        </label>
        {importMsg && <p className="small muted">{importMsg}</p>}
      </div>

      <div className="card stack">
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
        <div className="grid2">
          <label>
            Type
            <select value={type} onChange={(e) => setType(e.target.value as PropertyType)}>
              {PROPERTY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
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
      </div>

      <div className="card stack">
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
      <button className="primary" disabled={save.isPending || !!priceProblem} onClick={() => save.mutate()}>
        Save
      </button>
    </div>
  );
}
