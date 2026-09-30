// Household settings (people, budget, layers, criteria, tags, places, the walking limit) are shared and edited by
// everyone, while each device keeps its last copy to show at once and offline. A page that edits them asks the
// server every time it opens, and its controls wait for that answer, so an old copy is never saved over someone
// else's change.
import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";

/** Query options for anything the household edits together: always ask the server when a page opens. */
export const LIVE = { refetchOnMount: "always" } as const;

/** Controls that change household settings: shown straight away, usable once the server's current values are in.
 *  On a slow connection they dim after a moment (see .live.waiting). */
export function Live({ queries, children }: { queries: UseQueryResult[]; children: ReactNode }) {
  const live = queries.every((q) => q.isFetchedAfterMount && q.isSuccess);
  return <div className={`live ${live ? "" : "waiting"}`} inert={!live}>{children}</div>;
}

/** Said once on a page whose settings couldn't be checked with the server. */
export function OfflineNote({ queries }: { queries: UseQueryResult[] }) {
  if (!queries.some((q) => q.isError)) return null;
  return <p className="small error">You're offline. These are the last saved settings, and they can't be changed until you reconnect.</p>;
}
