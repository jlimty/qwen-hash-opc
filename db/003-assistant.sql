BEGIN;

-- The tender assistant: live GeBIZ open tenders, customer accounts, paid brief requests and test payments.

CREATE TABLE tender_desk.open_tenders (
  tender_no text PRIMARY KEY CHECK (length(btrim(tender_no)) BETWEEN 1 AND 100),
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  agency text NOT NULL,
  published_on date,
  closes_at timestamptz,
  gebiz_url text NOT NULL CHECK (gebiz_url LIKE 'https://www.gebiz.gov.sg/%'),
  source_feed text NOT NULL,
  category text NOT NULL,
  terms text[],
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tender_desk.feed_state (
  id integer PRIMARY KEY CHECK (id = 1),
  refreshed_at timestamptz
);
INSERT INTO tender_desk.feed_state (id, refreshed_at) VALUES (1, NULL);

CREATE TABLE tender_desk.customers (
  user_id text PRIMARY KEY CHECK (user_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  client_id uuid NOT NULL UNIQUE REFERENCES tender_desk.clients (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE tender_desk.request_ref_seq AS bigint;

CREATE TABLE tender_desk.brief_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_number bigint NOT NULL UNIQUE DEFAULT nextval('tender_desk.request_ref_seq'),
  client_id uuid NOT NULL REFERENCES tender_desk.clients (id),
  tender_no text NOT NULL CHECK (length(btrim(tender_no)) BETWEEN 1 AND 100),
  source text NOT NULL CHECK (source IN ('feed', 'pasted')),
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  agency text,
  pasted_text text CHECK (pasted_text IS NULL OR length(pasted_text) <= 4000),
  terms text[] NOT NULL,
  stat_id text NOT NULL CHECK (stat_id ~ '^stat_[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('requested', 'drafted', 'approved', 'declined', 'cancelled')),
  brief_id uuid REFERENCES tender_desk.briefs (id),
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 1000),
  decline_reason text CHECK (decline_reason IS NULL OR length(decline_reason) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX brief_requests_one_active ON tender_desk.brief_requests (client_id, tender_no)
  WHERE status IN ('requested', 'drafted');

CREATE TABLE tender_desk.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE REFERENCES tender_desk.brief_requests (id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 9007199254740991),
  currency text NOT NULL DEFAULT 'SGD' CHECK (currency = 'SGD'),
  status text NOT NULL CHECK (status IN ('test', 'paid', 'refunded')),
  created_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON ALL TABLES IN SCHEMA tender_desk FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA tender_desk FROM PUBLIC;

COMMIT;
