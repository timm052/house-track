-- 0020: "We've been to this house", ticked on its page, for houses seen without a recorded inspection (a private
-- viewing, a drive-by, an open home before House Track). One tick for the household: it counts as both of you
-- having gone, so the house moves to "Already inspected" and comes off the To inspect list.
CREATE TABLE property_inspected (
  property_id uuid PRIMARY KEY REFERENCES property ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid NOT NULL DEFAULT app_person() REFERENCES person
);
CREATE TRIGGER property_inspected_audit AFTER INSERT OR UPDATE OR DELETE ON property_inspected FOR EACH ROW EXECUTE FUNCTION audit_row();
