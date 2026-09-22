-- 0003 milestone 4: due-diligence checklist and auction bid log (PLAN.md §5 Should, additive).

CREATE TABLE checklist_item (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  campaign_id uuid NOT NULL REFERENCES campaign ON DELETE CASCADE,
  label       text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  sort        integer NOT NULL DEFAULT 0,
  done_at     timestamptz,
  done_by     uuid REFERENCES person,
  note        text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL DEFAULT app_person() REFERENCES person,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL DEFAULT app_person() REFERENCES person,
  CHECK ((done_at IS NULL) = (done_by IS NULL))
);
CREATE INDEX checklist_item_campaign_idx ON checklist_item (campaign_id, sort);
CREATE TRIGGER checklist_item_touch BEFORE UPDATE ON checklist_item FOR EACH ROW EXECUTE FUNCTION touch();
CREATE TRIGGER checklist_item_audit AFTER INSERT OR UPDATE OR DELETE ON checklist_item FOR EACH ROW EXECUTE FUNCTION audit_row();

-- One row per bid called on auction day, in order. Append-only like the other history tables;
-- a mistyped bid is removed (audited), not edited.
CREATE TABLE auction_bid (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  campaign_id uuid NOT NULL REFERENCES campaign ON DELETE CASCADE,
  amount_aud  integer NOT NULL CHECK (amount_aud > 0),
  bidder      text NOT NULL CHECK (bidder IN ('us', 'other', 'vendor')),
  label       text,               -- "Bidder A", "Blue jacket"
  called_at   timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL DEFAULT app_person() REFERENCES person
);
CREATE INDEX auction_bid_campaign_idx ON auction_bid (campaign_id, called_at);
CREATE TRIGGER auction_bid_append_only BEFORE UPDATE ON auction_bid FOR EACH ROW EXECUTE FUNCTION append_only();
CREATE TRIGGER auction_bid_audit AFTER DELETE ON auction_bid FOR EACH ROW EXECUTE FUNCTION audit_row();
