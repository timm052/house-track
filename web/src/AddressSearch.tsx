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
 *  has run, so callers must always offer another way to enter an address. */
export default function AddressSearch({ onPick, placeholder = "Start typing an address" }: {
  onPick: (hit: AddressHit) => void; placeholder?: string;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const term = useDebounced(q.trim());
  const { data = [], isFetching } = useQuery({
    queryKey: ["address-search", term],
    queryFn: () => api<AddressHit[]>(`/api/address/search?q=${encodeURIComponent(term)}`),
    enabled: term.length >= 4,
    staleTime: 60_000,
  });
  return (
    <div>
      <input
        type="search" placeholder={placeholder} value={q} autoComplete="off"
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
      />
      {open && term.length >= 4 && (
        <ul className="suggestions">
          {data.map((hit) => (
            <li key={hit.pid}>
              <button onClick={() => { onPick(hit); setQ(hit.display); setOpen(false); }}>{hit.display}</button>
            </li>
          ))}
          {!isFetching && data.length === 0 && <li className="small muted" style={{ padding: 10 }}>No matching address.</li>}
        </ul>
      )}
    </div>
  );
}
