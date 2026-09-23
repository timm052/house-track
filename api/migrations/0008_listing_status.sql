-- 0008: what the listing itself last said (from the weekly refresh or the + House Track button): sold, under
-- offer, taken down, and its price wording ("Sold for $1,250,000"). Used to ask for the outcome and prefill it.

ALTER TABLE campaign ADD COLUMN listing_status text;
ALTER TABLE campaign ADD COLUMN listing_price_text text;
ALTER TABLE campaign ADD COLUMN listing_checked_at timestamptz;
