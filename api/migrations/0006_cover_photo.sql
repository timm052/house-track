-- 0006: each house's cover photo, shown on its page, its card in the list and on the map. Someone can choose
-- one; otherwise it's the listing's main photo (the first one saved from the listing, since capture saves them
-- in the listing's order), and failing that the newest photo.

ALTER TABLE property ADD COLUMN cover_photo_id uuid REFERENCES attachment ON DELETE SET NULL;

CREATE VIEW property_cover AS
SELECT DISTINCT ON (a.property_id) a.property_id, a.id AS attachment_id
FROM attachment a
JOIN property p ON p.id = a.property_id
WHERE a.sha256 IS NOT NULL AND a.mime_type LIKE 'image/%'
ORDER BY a.property_id,
         (a.id = p.cover_photo_id) IS TRUE DESC,
         (a.caption = 'From the listing') IS TRUE DESC,
         CASE WHEN a.caption = 'From the listing' THEN a.created_at END ASC,
         a.created_at DESC;
