"""Phone notifications: subscribing a device, and who hears about what."""

from .conftest import as_


class Now:
    """Runs a background thread's work straight away, so a test can see what was sent."""
    def __init__(self, target, name=None, daemon=None):
        self.target = target

    def start(self):
        self.target()


def test_notifications(client, people, monkeypatch, tmp_path):
    from app import push
    monkeypatch.setenv("VAPID_KEY_FILE", str(tmp_path / "vapid.pem"))
    monkeypatch.setattr(push.threading, "Thread", Now)
    sent: list[tuple[str, dict]] = []
    monkeypatch.setattr(push, "_send_one", lambda sub, payload, key: sent.append((sub["endpoint"], payload)) or sub["endpoint"] != "https://push.test/gone")

    key = client.get("/api/push/key").json()["key"]
    assert len(key) == 87 and client.get("/api/push/key").json()["key"] == key  # made once, then kept
    a, b = people["a"], people["b"]
    dev = lambda n, kinds=None: {"endpoint": f"https://push.test/{n}", "keys": {"p256dh": "k", "auth": "a"}, **({"kinds": kinds} if kinds else {})}
    assert client.post("/api/push/subscriptions", headers=as_(a), json=dev("a")).status_code == 200
    client.post("/api/push/subscriptions", headers=as_(b), json=dev("b"))
    client.post("/api/push/subscriptions", headers=as_(b), json=dev("b-quiet", ["shortlist"]))
    assert client.post("/api/push/subscriptions/find", json={"endpoint": "https://push.test/b-quiet"}).json() == {"subscribed": True, "kinds": ["shortlist"]}

    pid = client.post("/api/properties", headers=as_(a), json={
        "address": {"street_number": "4", "street": "Ping Street", "suburb": "Mitcham", "postcode": "3132"},
        "campaign": {"sale_method": "private_sale"}}).json()["id"]
    # a updates the listing: b hears about the new guide (not a, who did it, nor b's quiet phone).
    sent.clear()
    client.post(f"/api/properties/{pid}/listing-update", headers=as_(a), json={"guide_low_aud": 900_000, "guide_high_aud": 950_000})
    assert [(e, p["title"]) for e, p in sent] == [("https://push.test/b", "4 Ping Street, Mitcham")]
    assert sent[0][1]["body"].startswith("New price guide $900k") and sent[0][1]["url"] == f"/p/{pid}"
    # A preview says nothing.
    sent.clear()
    client.post(f"/api/properties/{pid}/listing-update?preview=true", headers=as_(a), json={"guide_low_aud": 800_000})
    assert sent == []
    # b shortlists it: a hears, once.
    client.post(f"/api/properties/{pid}/shortlist", headers=as_(b))
    client.post(f"/api/properties/{pid}/shortlist", headers=as_(b))
    assert [(e, p["title"], p["body"]) for e, p in sent] == [("https://push.test/a", "Sam shortlisted a house", "4 Ping Street, Mitcham")]
    # A device the push service has forgotten is dropped.
    client.post("/api/push/subscriptions", headers=as_(a), json=dev("gone"))
    sent.clear()
    assert client.post("/api/push/test", headers=as_(a)).json()["devices"] == 2
    assert sorted(e for e, _ in sent) == ["https://push.test/a", "https://push.test/gone"]
    assert client.post("/api/push/subscriptions/find", json={"endpoint": "https://push.test/gone"}).json()["subscribed"] is False
    assert client.post("/api/push/subscriptions/remove", headers=as_(a), json={"endpoint": "https://push.test/a"}).status_code == 204
    assert client.post("/api/push/subscriptions/find", json={"endpoint": "https://push.test/a"}).json()["subscribed"] is False
