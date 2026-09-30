-- 0019: phone notifications. One row per device that turned them on, with what it wants to hear about.
CREATE TABLE push_subscription (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  person_id  uuid NOT NULL REFERENCES person ON DELETE CASCADE,
  endpoint   text NOT NULL UNIQUE,
  p256dh     text NOT NULL,
  auth       text NOT NULL,
  kinds      text[] NOT NULL DEFAULT ARRAY['guide', 'inspections', 'sale', 'shortlist'],
  created_at timestamptz NOT NULL DEFAULT now()
);
