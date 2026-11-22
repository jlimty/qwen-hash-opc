BEGIN;

-- Site settings that are not secrets. The console admin's Neon Auth user ID lives here, so changing the admin needs no
-- redeploy and no hand-pasted setting.
CREATE TABLE tender_desk.settings (
  key text PRIMARY KEY CHECK (key ~ '^[a-z_]{1,64}$'),
  value text NOT NULL CHECK (length(value) BETWEEN 1 AND 500),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
