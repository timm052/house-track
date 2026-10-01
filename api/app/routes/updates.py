"""The Updates feed: what has happened to the houses lately, newest first.

Built from what's already recorded: houses added, price guides that changed (with the guide before), status changes,
sales and "under offer" (from the audit log of the campaign), and new inspection times for a house that's been
tracked a while. Verdicts aren't in it: they have their own places (Rate, the house page, the cards on Updates). The web
app turns each into a line of text.
"""

from typing import Annotated

from fastapi import APIRouter, Query

from ..db import tx

router = APIRouter(prefix="/api")

FEED = """
WITH ev AS (
  SELECT p.created_at AS at, 'added'::text AS kind, p.id AS property_id, p.created_by AS person_id, '{}'::jsonb AS data
    FROM property p
  UNION ALL
  -- a guide that changed: shown with the one before it (the first guide of a campaign isn't news)
  SELECT g.created_at, 'guide', c.property_id, g.created_by,
         jsonb_build_object('source', g.source, 'low', g.low_aud, 'high', g.high_aud,
                            'prev_low', g.prev_low, 'prev_high', g.prev_high, 'note', g.note)
    FROM (SELECT g.*, lag(g.low_aud) OVER w AS prev_low, lag(g.high_aud) OVER w AS prev_high
            FROM price_guide g WINDOW w AS (PARTITION BY g.campaign_id ORDER BY g.observed_at, g.id)) g
    JOIN campaign c ON c.id = g.campaign_id
   WHERE g.prev_low IS NOT NULL AND (g.low_aud, g.high_aud) <> (g.prev_low, g.prev_high)
  UNION ALL
  -- (the "watching" a new house starts with is the house being added, not news)
  SELECT s.occurred_at, 'status', s.property_id, s.created_by, jsonb_build_object('status', s.status, 'reason', s.reason)
    FROM status_event s JOIN property sp ON sp.id = s.property_id
   WHERE NOT (s.status = 'watching' AND s.occurred_at < sp.created_at + interval '2 minutes')
  UNION ALL
  -- how a sale ended, and the price when it turns up later
  SELECT a.at, 'sale', (a.new_row ->> 'property_id')::uuid, a.person_id,
         jsonb_build_object('outcome', a.new_row ->> 'outcome', 'price', (a.new_row ->> 'sold_price_aud')::int,
                            'ours', coalesce((a.new_row ->> 'bought_by_us')::boolean, false))
    FROM audit_log a
   WHERE a.table_name = 'campaign' AND a.op = 'U' AND a.old_row ->> 'outcome' IS NULL AND a.new_row ->> 'outcome' IS NOT NULL
  UNION ALL
  SELECT a.at, 'sale_price', (a.new_row ->> 'property_id')::uuid, a.person_id,
         jsonb_build_object('outcome', a.new_row ->> 'outcome', 'price', (a.new_row ->> 'sold_price_aud')::int)
    FROM audit_log a
   WHERE a.table_name = 'campaign' AND a.op = 'U' AND a.old_row ->> 'outcome' IS NOT NULL
     AND a.old_row ->> 'sold_price_aud' IS NULL AND a.new_row ->> 'sold_price_aud' IS NOT NULL
  UNION ALL
  -- what the listing says it is now, when that's news
  SELECT a.at, 'listing', (a.new_row ->> 'property_id')::uuid, a.person_id, jsonb_build_object('listing', a.new_row ->> 'listing_status')
    FROM audit_log a
   WHERE a.table_name = 'campaign' AND a.op = 'U'
     AND coalesce(a.old_row ->> 'listing_status', '') <> coalesce(a.new_row ->> 'listing_status', '')
     AND lower(regexp_replace(coalesce(a.new_row ->> 'listing_status', ''), '[^a-zA-Z]', '', 'g')) IN ('underoffer', 'withdrawn', 'archived', 'offmarket')
  UNION ALL
  -- new inspection times for a house that's been tracked a while (a new house brings its own)
  SELECT max(a.at), 'inspections', (a.new_row ->> 'property_id')::uuid, a.person_id,
         jsonb_build_object('count', count(*), 'first', min(a.new_row ->> 'starts_at'))
    FROM audit_log a JOIN property p ON p.id = (a.new_row ->> 'property_id')::uuid
   WHERE a.table_name = 'inspection' AND a.op = 'I' AND a.at > p.created_at + interval '10 minutes'
   GROUP BY (a.new_row ->> 'property_id'), date_trunc('minute', a.at), a.person_id
)
SELECT ev.at, ev.kind, ev.property_id, ev.person_id, ev.data
  FROM ev JOIN property p ON p.id = ev.property_id
 WHERE ev.at >= now() - make_interval(days => %s)
 ORDER BY ev.at DESC
 LIMIT 400
"""


@router.get("/updates")
def updates(days: Annotated[int, Query(ge=1, le=120)] = 30) -> list[dict]:
    """The feed, newest first: each has `kind`, when (`at`), the house, who did it (`person_id`) and `data` for its details."""
    with tx() as conn:
        return conn.execute(FEED, (days,)).fetchall()
