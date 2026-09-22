// Changes waiting on this phone for a connection, and any that came back as conflicts (D17).
import { useQueryClient } from "@tanstack/react-query";
import { flush, resolve, useOutbox } from "../outbox";
import { LABEL } from "../format";

export default function Outbox() {
  const queryClient = useQueryClient();
  const items = useOutbox(() => queryClient.invalidateQueries());
  return (
    <div className="card stack" style={{ marginTop: 12 }}>
      <h2>Waiting to send</h2>
      {items.length === 0 && <p className="muted">Nothing waiting. Everything's saved on the server.</p>}
      {items.map((i) => (
        <div key={i.id} className="conflict">
          <div>{i.label}</div>
          <div className="small muted">Typed {new Date(i.createdAt).toLocaleString("en-AU")}</div>
          {i.conflict && (
            <>
              <div className="small">
                {i.conflict.changedBy ?? "Someone"} changed this meanwhile to{" "}
                <strong>{LABEL.stance[i.conflict.current as "yes"] ?? String(i.conflict.current ?? "blank")}</strong>.
              </div>
              <div className="row">
                <button onClick={() => resolve(i.id, "mine").then(() => queryClient.invalidateQueries())}>Keep mine</button>
                <button onClick={() => resolve(i.id, "theirs")}>Keep theirs</button>
              </div>
            </>
          )}
          {i.error && <div className="small error">{i.error}</div>}
        </div>
      ))}
      {items.some((i) => !i.conflict) && <button onClick={() => flush(() => queryClient.invalidateQueries())}>Try sending now</button>}
    </div>
  );
}
