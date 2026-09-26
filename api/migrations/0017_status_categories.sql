-- 0017: a house's status says where we're up to with it, and only that. What happened to its sale (sold, passed
-- in, withdrawn) is the campaign's outcome, shown beside it, so a house we only watched that sold stays "watching"
-- instead of becoming "lost".
--   watching → watching, inspecting → interested, shortlisted → shortlisted, bidding → offering, bought → bought,
--   rejected → ruled_out;
--   lost → missed_out if we'd been offering on it, otherwise back to the status it had before;
--   withdrawn → back to the status it had before (the campaign keeps the withdrawal).
-- Every house keeps its history, with the new names; saved grid views follow.

-- A data fix, not anyone's edit: the history is otherwise append-only, and the view's touch trigger wants a person.
ALTER TABLE status_event DISABLE TRIGGER status_event_append_only;
ALTER TABLE status_event DROP CONSTRAINT status_event_status_check;

UPDATE status_event SET status = CASE status WHEN 'inspecting' THEN 'interested' WHEN 'bidding' THEN 'offering'
                                             WHEN 'rejected' THEN 'ruled_out' END
 WHERE status IN ('inspecting', 'bidding', 'rejected');

-- (The subqueries see the table as it was before this statement, so a run of lost and withdrawn entries all go
-- back to the last real status before them.)
UPDATE status_event e SET status = CASE
    WHEN e.status = 'lost' AND EXISTS (SELECT 1 FROM status_event b WHERE b.property_id = e.property_id AND b.status = 'offering'
                                         AND (b.occurred_at, b.id) < (e.occurred_at, e.id)) THEN 'missed_out'
    ELSE coalesce((SELECT p.status FROM status_event p
                    WHERE p.property_id = e.property_id AND p.status NOT IN ('lost', 'withdrawn') AND (p.occurred_at, p.id) < (e.occurred_at, e.id)
                    ORDER BY p.occurred_at DESC, p.id DESC LIMIT 1), 'watching')
  END
 WHERE e.status IN ('lost', 'withdrawn');

ALTER TABLE status_event ADD CONSTRAINT status_event_status_check
  CHECK (status IN ('watching', 'interested', 'shortlisted', 'offering', 'bought', 'missed_out', 'ruled_out'));
ALTER TABLE status_event ENABLE TRIGGER status_event_append_only;

-- Saved views that filter on status: the same names (withdrawn has none, so it drops out of the list).
ALTER TABLE grid_view DISABLE TRIGGER grid_view_touch;
UPDATE grid_view g SET filters = (
  SELECT jsonb_agg(CASE WHEN f ->> 'column' = 'status' AND jsonb_typeof(f -> 'value') = 'array'
           THEN jsonb_set(f, '{value}', coalesce((
             SELECT jsonb_agg(DISTINCT m.new) FROM jsonb_array_elements_text(f -> 'value') AS v(old)
             JOIN (VALUES ('watching', 'watching'), ('inspecting', 'interested'), ('shortlisted', 'shortlisted'), ('bidding', 'offering'),
                          ('bought', 'bought'), ('rejected', 'ruled_out'), ('lost', 'missed_out')) AS m(old, new) ON m.old = v.old), '[]'::jsonb))
           ELSE f END ORDER BY i)
  FROM jsonb_array_elements(g.filters) WITH ORDINALITY AS x(f, i))
 WHERE jsonb_typeof(g.filters) = 'array' AND jsonb_array_length(g.filters) > 0;
ALTER TABLE grid_view ENABLE TRIGGER grid_view_touch;
