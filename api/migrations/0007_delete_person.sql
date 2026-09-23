-- 0007: people can be deleted (Settings → People). Their own verdicts, scores, areas and attendance go with them;
-- everything else they created or last edited is handed to whoever deletes them. History tables stay append-only,
-- except that while a hand-over is running (app.handing_over = 'on', set for that one transaction) the only change
-- allowed is who created a row.

CREATE OR REPLACE FUNCTION append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.handing_over', true) = 'on'
     AND (to_jsonb(NEW) - 'created_by') = (to_jsonb(OLD) - 'created_by') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only; insert a new row', TG_TABLE_NAME;
END $$;
