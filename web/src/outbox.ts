// Offline outbox (PLAN.md D6, D17): opinions, notes, logged inspections and photos taken with no signal
// wait here, in IndexedDB (photos as the files themselves), and are sent when the connection returns. Each item carries its own id so a resend is a no-op, and
// verdicts carry the version the phone last saw so a change made meanwhile comes back as a conflict.
import { del, get, set } from "idb-keyval";
import { useEffect, useState } from "react";
import { api, ApiError, getActingPerson } from "./api";

export type OutboxItem = {
  id: string;
  method: "POST" | "PUT" | "PATCH";
  path: string;
  body: Record<string, unknown>;
  /** An upload instead of JSON: form fields plus the files, sent as multipart. */
  files?: { name: string; type: string; data: Blob }[];
  label: string; // shown in the outbox list, e.g. "Your verdict: Yes for 12 Smith St"
  propertyId?: string;
  createdAt: string;
  conflict?: { current: unknown; changedBy: string | null; changedAt: string | null };
  error?: string;
};

const KEY = "housetrack.outbox";
const listeners = new Set<(items: OutboxItem[]) => void>();
let flushing = false;

async function load(): Promise<OutboxItem[]> {
  try {
    return (await get<OutboxItem[]>(KEY)) ?? [];
  } catch {
    return [];
  }
}

async function save(items: OutboxItem[]): Promise<void> {
  try {
    if (items.length) await set(KEY, items);
    else await del(KEY);
  } catch {
    /* storage unavailable: items live only in memory for this session */
  }
  listeners.forEach((l) => l(items));
}

// No network, or the server unreachable behind the web front end (502-504): keep the change for later.
const isOffline = (e: unknown) =>
  e instanceof TypeError || (e instanceof ApiError && [502, 503, 504].includes(e.status)) ||
  (typeof navigator !== "undefined" && !navigator.onLine);

async function send(item: Omit<OutboxItem, "createdAt">): Promise<void> {
  if (!item.files) {
    await api(item.path, { method: item.method, body: item.body });
    return;
  }
  const form = new FormData();
  for (const [k, v] of Object.entries(item.body)) if (v != null) form.append(k, String(v));
  for (const f of item.files) form.append("file", new File([f.data], f.name, { type: f.type }));
  const res = await fetch(item.path, { method: item.method, body: form, headers: { "X-Person-Id": getActingPerson() ?? "" } });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, data?.detail ?? res.statusText);
  }
}

/** Send now if possible, otherwise queue. Returns "sent", "queued" or throws a real (non-network) error. */
export async function sendOrQueue(item: Omit<OutboxItem, "createdAt">): Promise<"sent" | "queued"> {
  try {
    await send(item);
    return "sent";
  } catch (e) {
    if (!isOffline(e)) throw e;
    await save([...(await load()), { ...item, createdAt: new Date().toISOString() }]);
    return "queued";
  }
}

export async function flush(onSent?: (item: OutboxItem) => void): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    let items = await load();
    for (const item of items.filter((i) => !i.conflict)) {
      try {
        await send(item);
        items = items.filter((i) => i.id !== item.id);
        await save(items);
        onSent?.(item);
      } catch (e) {
        if (isOffline(e)) break; // still no signal: try again later
        const err = e as ApiError;
        const d = err.detail as { current?: unknown; changed_by?: string | null; changed_at?: string | null } | undefined;
        items = items.map((i) => (i.id !== item.id ? i : err.status === 409
          ? { ...i, conflict: { current: d?.current, changedBy: d?.changed_by ?? null, changedAt: d?.changed_at ?? null } }
          : { ...i, error: err.message }));
        await save(items);
      }
    }
  } finally {
    flushing = false;
  }
}

/** Resolve a conflict: "mine" resends without the check; "theirs" drops the queued change. */
export async function resolve(id: string, keep: "mine" | "theirs"): Promise<void> {
  let items = await load();
  const item = items.find((i) => i.id === id);
  if (!item) return;
  items = items.filter((i) => i.id !== id);
  if (keep === "mine") {
    const { check_latest: _c, expected_latest_id: _e, ...body } = item.body;
    items.push({ ...item, body, conflict: undefined, error: undefined });
  }
  await save(items);
  if (keep === "mine") await flush();
}

export function useOutbox(onSent?: (item: OutboxItem) => void): OutboxItem[] {
  const [items, setItems] = useState<OutboxItem[]>([]);
  useEffect(() => {
    load().then(setItems);
    listeners.add(setItems);
    const tryFlush = () => flush(onSent);
    tryFlush();
    window.addEventListener("online", tryFlush);
    document.addEventListener("visibilitychange", tryFlush);
    const timer = window.setInterval(tryFlush, 20_000);
    return () => {
      listeners.delete(setItems);
      window.removeEventListener("online", tryFlush);
      document.removeEventListener("visibilitychange", tryFlush);
      window.clearInterval(timer);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return items;
}

export const newId = (): string =>
  crypto.randomUUID?.() ?? "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (+c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c / 4)))).toString(16));

/** Upload photos or documents for a house, one queued item per file: sent now if there's signal, otherwise kept
 *  on this device and sent later. Used by the Photos tab and the Drive page. */
export async function uploadFiles(propertyId: string, address: string, files: File[], kind = "photo"):
    Promise<{ sent: number; queued: number }> {
  const out = { sent: 0, queued: 0 };
  for (const file of files) {
    const result = await sendOrQueue({
      id: newId(), method: "POST", path: `/api/properties/${propertyId}/attachments`, propertyId,
      body: { kind }, files: [{ name: file.name, type: file.type, data: file }], label: `${kind === "photo" ? "Photo" : "File"} for ${address}`,
    });
    out[result] += 1;
  }
  return out;
}

/** "Sent", or how many are waiting for a signal. */
export const uploadMessage = ({ sent, queued }: { sent: number; queued: number }, noun = "photo") =>
  queued ? `${queued} ${noun}${queued > 1 ? "s" : ""} saved on this phone. ${queued > 1 ? "They" : "It"} upload${queued > 1 ? "" : "s"} when you're back online.`
    : `${sent} ${noun}${sent > 1 ? "s" : ""} uploaded`;
