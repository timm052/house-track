"""Notifications on this device: the server's public key, and turning a device's subscription on, off or changing
what it hears about (see app/push.py)."""

from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .. import push
from ..db import tx
from ..deps import Person

router = APIRouter(prefix="/api")
Kind = Literal["guide", "inspections", "sale", "shortlist"]


class Keys(BaseModel):
    p256dh: str = Field(max_length=200)
    auth: str = Field(max_length=100)


class SubscriptionIn(BaseModel):
    endpoint: str = Field(pattern=r"^https://", max_length=1000)
    keys: Keys
    kinds: list[Kind] = Field(default_factory=lambda: list(push.KINDS))


@router.get("/push/key")
def key() -> dict:
    return {"key": push.public_key()}


@router.post("/push/subscriptions")
def subscribe(body: SubscriptionIn, person: Person) -> dict:
    """Turn notifications on for this device, or change what it hears about. Safe to repeat."""
    with tx(person) as conn:
        conn.execute(
            """INSERT INTO push_subscription (person_id, endpoint, p256dh, auth, kinds) VALUES (%s, %s, %s, %s, %s)
               ON CONFLICT (endpoint) DO UPDATE SET person_id = EXCLUDED.person_id, p256dh = EXCLUDED.p256dh,
                   auth = EXCLUDED.auth, kinds = EXCLUDED.kinds""",
            (person, body.endpoint, body.keys.p256dh, body.keys.auth, body.kinds))
    return {"endpoint": body.endpoint, "kinds": body.kinds}


class EndpointIn(BaseModel):
    endpoint: str = Field(max_length=1000)


@router.post("/push/subscriptions/remove", status_code=204)
def unsubscribe(body: EndpointIn, person: Person) -> None:
    with tx(person) as conn:
        conn.execute("DELETE FROM push_subscription WHERE endpoint = %s", (body.endpoint,))


@router.post("/push/subscriptions/find")
def find(body: EndpointIn) -> dict:
    """What this device hears about, if it's subscribed."""
    with tx() as conn:
        row = conn.execute("SELECT kinds FROM push_subscription WHERE endpoint = %s", (body.endpoint,)).fetchone()
    return {"subscribed": row is not None, "kinds": row["kinds"] if row else []}


@router.post("/push/test", status_code=202)
def test(person: Person) -> dict:
    """A test notification to the person's own devices."""
    with tx() as conn:
        n = conn.execute("SELECT count(*) AS n FROM push_subscription WHERE person_id = %s", (person,)).fetchone()["n"]
    push.send(None, "House Track", "Notifications are working.", "/settings", only=person)
    return {"devices": n}
