import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, setActingPerson, type Person } from "../api";

const COLOURS = ["#1f77b4", "#d62728", "#2ca02c", "#9467bd", "#ff7f0e"];

/** First run: name the household's members. Identity only; there are no passwords. */
export default function Setup({ onDone }: { onDone: (personId: string) => void }) {
  const queryClient = useQueryClient();
  const [rows, setRows] = useState([{ name: "", colour: COLOURS[0] }, { name: "", colour: COLOURS[1] }]);
  const [walkLimit, setWalkLimit] = useState("20");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const named = rows.filter((r) => r.name.trim());

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const created: Person[] = [];
      for (const r of named) {
        created.push(await api<Person>("/api/persons", { method: "POST", body: { display_name: r.name.trim(), colour: r.colour } }));
      }
      setActingPerson(created[0].id);
      await api("/api/settings/walk_limit_min", { method: "PUT", body: { value: Number(walkLimit) || 20 } });
      await queryClient.invalidateQueries({ queryKey: ["persons"] });
      onDone(created[0].id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <div className="card stack" style={{ marginTop: 32 }}>
        <h1>Set up House Track</h1>
        <p className="muted">
          Who's in this household? Everyone's verdicts, notes and map areas are kept under their name. There are no passwords.
        </p>
        {rows.map((r, i) => (
          <div className="row" key={i}>
            <input
              className="grow"
              placeholder={`Person ${i + 1}`}
              value={r.name}
              onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
            />
            <input
              type="color"
              aria-label="Colour"
              value={r.colour}
              style={{ width: 56, padding: 4 }}
              onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, colour: e.target.value } : x)))}
            />
          </div>
        ))}
        <button className="link" onClick={() => setRows([...rows, { name: "", colour: COLOURS[rows.length % COLOURS.length] }])}>
          + Add another person
        </button>
        <label>
          Walking limit to stations (minutes)
          <input inputMode="numeric" value={walkLimit} onChange={(e) => setWalkLimit(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy || named.length === 0} onClick={save}>
          Start
        </button>
      </div>
    </main>
  );
}
