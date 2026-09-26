-- 0016: a kept copy remembers the link it came from. Downloading a linked document (the Statement of Information,
-- "Keep a copy") cleared its link, so capturing the listing again didn't know it was there and added it again,
-- once per update. Listing photos and floor plans remember theirs too, so they aren't downloaded again.

ALTER TABLE attachment ADD COLUMN source_url text;

-- A data fix, not anyone's edit: the touch triggers would demand a person for updated_by.
ALTER TABLE attachment DISABLE TRIGGER attachment_touch;
ALTER TABLE property DISABLE TRIGGER property_touch;
ALTER TABLE comparable_sale DISABLE TRIGGER comparable_sale_touch;

-- The links of copies kept before now, from the audit log.
UPDATE attachment a SET source_url = l.url
  FROM (SELECT DISTINCT ON (row_id) row_id, old_row ->> 'url' AS url FROM audit_log
         WHERE table_name = 'attachment' AND op = 'U' AND old_row ->> 'url' IS NOT NULL AND new_row ->> 'url' IS NULL
         ORDER BY row_id, at DESC) l
 WHERE a.id::text = l.row_id AND a.url IS NULL;

-- The copies those updates added: the same file on the same house, for the same campaign. The first one stays,
-- and whatever pointed at a later copy points at it instead.
CREATE TEMP TABLE attachment_dupe ON COMMIT DROP AS
SELECT id, keep FROM (
  SELECT id, first_value(id) OVER (PARTITION BY property_id, campaign_id, kind, sha256 ORDER BY created_at, id) AS keep
    FROM attachment WHERE sha256 IS NOT NULL) r
 WHERE id <> keep;

UPDATE attachment k SET source_url = d.source_url
  FROM (SELECT DISTINCT ON (d.keep) d.keep, a.source_url FROM attachment_dupe d JOIN attachment a ON a.id = d.id
         WHERE a.source_url IS NOT NULL ORDER BY d.keep, a.created_at DESC) d
 WHERE k.id = d.keep AND k.source_url IS NULL;
UPDATE property p SET cover_photo_id = d.keep FROM attachment_dupe d WHERE p.cover_photo_id = d.id;
UPDATE comparable_sale c SET attachment_id = d.keep FROM attachment_dupe d WHERE c.attachment_id = d.id;
DO $$ BEGIN
  IF to_regclass('floorplan_markup') IS NOT NULL THEN
    ALTER TABLE floorplan_markup DISABLE TRIGGER floorplan_markup_touch;
    UPDATE floorplan_markup m SET attachment_id = d.keep FROM attachment_dupe d WHERE m.attachment_id = d.id;
    ALTER TABLE floorplan_markup ENABLE TRIGGER floorplan_markup_touch;
  END IF;
END $$;
DELETE FROM attachment WHERE id IN (SELECT id FROM attachment_dupe);

ALTER TABLE attachment ENABLE TRIGGER attachment_touch;
ALTER TABLE property ENABLE TRIGGER property_touch;
ALTER TABLE comparable_sale ENABLE TRIGGER comparable_sale_touch;
