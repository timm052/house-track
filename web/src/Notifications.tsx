// Settings: notifications on this device. Each phone or computer turns them on for itself and picks what to hear
// about; the server sends them through the browser's own push service (see api/app/push.py and public/push-sw.js).
// iPhones only allow this for House Track once it's added to the Home Screen and opened from there.
import { useEffect, useState } from "react";
import { api } from "./api";

type Kind = "guide" | "inspections" | "sale" | "shortlist";
const KINDS: [Kind, string][] = [
  ["guide", "Price guide changes"],
  ["inspections", "New inspection times"],
  ["sale", "Under offer and sold"],
  ["shortlist", "Houses someone else shortlists"],
];
const ALL = KINDS.map(([k]) => k);

const supported = typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const ios = typeof navigator !== "undefined" && /iPhone|iPad|iPod/.test(navigator.userAgent);

/** The app's service worker, which shows notifications; null if it isn't running within a few seconds (some
 *  embedded or private browsers don't run one). */
async function worker(wait = 6000): Promise<ServiceWorkerRegistration | null> {
  const now = await navigator.serviceWorker.getRegistration();
  if (now?.active) return now;
  return Promise.race([navigator.serviceWorker.ready, new Promise<null>((done) => setTimeout(() => done(null), wait))]);
}

/** The server's public key, as the bytes the browser wants. */
function keyBytes(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob((b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export default function Notifications() {
  const [sub, setSub] = useState<PushSubscription | null>(null);
  const [kinds, setKinds] = useState<Kind[]>(ALL);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // What this device already has.
  useEffect(() => {
    if (!supported) return;
    (async () => {
      try {
        const reg = await worker(2000);
        const s = reg && await reg.pushManager.getSubscription();
        if (s) {
          const found = await api<{ subscribed: boolean; kinds: Kind[] }>("/api/push/subscriptions/find", { method: "POST", body: { endpoint: s.endpoint } });
          if (found.subscribed) { setSub(s); setKinds(found.kinds); }
        }
      } catch { /* offline: shown as off */ }
      setReady(true);
    })();
  }, []);

  async function save(s: PushSubscription, k: Kind[]) {
    const json = s.toJSON();
    await api("/api/push/subscriptions", { method: "POST", body: { endpoint: s.endpoint, keys: json.keys, kinds: k } });
  }

  async function turnOn() {
    setBusy(true); setMsg(null);
    try {
      if ((await Notification.requestPermission()) !== "granted") {
        setMsg("Notifications are blocked for House Track. Allow them in your browser or phone settings.");
        return;
      }
      const { key } = await api<{ key: string }>("/api/push/key");
      const reg = await worker();
      if (!reg) {
        setMsg("This browser isn't running House Track's background support. Reload the page and try again.");
        return;
      }
      const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
      await save(s, kinds);
      setSub(s);
    } catch (e) {
      setMsg(`Couldn't turn on notifications: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    if (!sub) return;
    setBusy(true); setMsg(null);
    try {
      await api("/api/push/subscriptions/remove", { method: "POST", body: { endpoint: sub.endpoint } });
      await sub.unsubscribe();
      setSub(null);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function flip(k: Kind) {
    const next = kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k];
    setKinds(next);
    if (sub) {
      try { await save(sub, next); } catch (e) { setMsg((e as Error).message); }
    }
  }

  async function test() {
    setMsg(null);
    try {
      await api("/api/push/test", { method: "POST" });
      setMsg("Sent. It should arrive in a few seconds.");
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <div className="card stack" id="notifications">
      <h2>Notifications</h2>
      {!supported ? (
        <p className="small muted" style={{ margin: 0 }}>{ios
          ? "On iPhone, add House Track to your Home Screen (Share → Add to Home Screen), open it from there, then turn notifications on here."
          : "This browser doesn't support notifications."}</p>
      ) : (
        <>
          <p className="small muted" style={{ margin: 0 }}>On this device. Each person's own changes aren't sent to them.</p>
          <div className="row">
            {sub ? <button onClick={turnOff} disabled={busy}>Turn off</button>
              : <button className="primary" onClick={turnOn} disabled={busy || !ready}>Turn on notifications</button>}
            {sub && <button className="link" onClick={test}>Send a test</button>}
          </div>
          <div className="stack" style={{ gap: 4 }}>
            {KINDS.map(([k, label]) => (
              <label key={k} className="check"><input type="checkbox" checked={kinds.includes(k)} onChange={() => flip(k)} /> {label}</label>
            ))}
          </div>
        </>
      )}
      {msg && <p className="small muted" style={{ margin: 0 }}>{msg}</p>}
    </div>
  );
}
