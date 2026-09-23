import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, type AddressHit } from "./api";

function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Type-ahead over the region's G-NAF addresses (loaded by the setup job). Shows nothing until setup
 *  has run, so callers must always offer another way to enter an address. Arrow keys move through the
 *  matches, Enter picks one (the first if none is highlighted), Escape closes the list. `dropUp` opens the
 *  list above the box, for boxes at the bottom of the screen. `clearOnPick` empties the box after a pick. */
export default function AddressSearch({ onPick, placeholder = "Start typing an address", dropUp = false, clearOnPick = false, autoFocus = false }: {
  onPick: (hit: AddressHit) => void; placeholder?: string; dropUp?: boolean; clearOnPick?: boolean; autoFocus?: boolean;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const term = useDebounced(q.trim());
  const { data = [], isFetching } = useQuery({
    queryKey: ["address-search", term],
    queryFn: () => api<AddressHit[]>(`/api/address/search?q=${encodeURIComponent(term)}`),
    enabled: term.length >= 4,
    staleTime: 60_000,
  });
  useEffect(() => setActive(-1), [data]);
  function pick(hit: AddressHit) {
    onPick(hit);
    setQ(clearOnPick ? "" : hit.display);
    setOpen(false);
  }
  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || term.length < 4) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, data.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && data.length) { e.preventDefault(); pick(data[Math.max(active, 0)]); }
    else if (e.key === "Escape") setOpen(false);
  }
  return (
    <div className={`address-search ${dropUp ? "drop-up" : ""}`}>
      <input
        type="search" placeholder={placeholder} value={q} autoComplete="off" autoFocus={autoFocus}
        role="combobox" aria-expanded={open && term.length >= 4} aria-autocomplete="list"
        onChange={(e) => { setQ(e.target.value); setOpen(true); }} onKeyDown={onKeyDown}
      />
      {open && term.length >= 4 && (
        <ul className="suggestions" role="listbox">
          {data.map((hit, i) => (
            <li key={hit.pid} role="option" aria-selected={i === active}>
              <button className={i === active ? "active" : ""} onMouseEnter={() => setActive(i)} onClick={() => pick(hit)}>{hit.display}</button>
            </li>
          ))}
          {!isFetching && data.length === 0 && <li className="small muted" style={{ padding: 10 }}>No matching address.</li>}
        </ul>
      )}
    </div>
  );
}
