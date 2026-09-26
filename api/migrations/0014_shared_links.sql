-- 0014: listing links shared from a phone that couldn't become a house straight away (a realestate.com.au link has
-- no address in it, nor does a lot or an agent's own site). They wait here for someone to finish adding them; one
-- that has since been added (its link is on a campaign) or dismissed isn't shown.

CREATE TABLE shared_link (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  url          text NOT NULL UNIQUE,
  shared_by    uuid REFERENCES person ON DELETE SET NULL,
  shared_at    timestamptz NOT NULL DEFAULT now(),
  dismissed_at timestamptz
);
