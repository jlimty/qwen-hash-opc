BEGIN;

CREATE SCHEMA tender_desk;

CREATE TABLE tender_desk.clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  capabilities text NOT NULL,
  categories text[] NOT NULL,
  team_size integer NOT NULL CHECK (team_size > 0),
  max_contract_cents bigint NOT NULL CHECK (max_contract_cents BETWEEN 0 AND 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX clients_name_case_insensitive ON tender_desk.clients (lower(name));

CREATE TABLE tender_desk.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES tender_desk.clients (id),
  title text NOT NULL,
  agency text,
  value_cents bigint CHECK (value_cents BETWEEN 0 AND 9007199254740991),
  verified boolean NOT NULL DEFAULT false
);

CREATE TABLE tender_desk.agent_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  role text NOT NULL CHECK (role IN ('client', 'intake')),
  client_id uuid REFERENCES tender_desk.clients (id),
  CHECK ((role = 'client' AND client_id IS NOT NULL) OR (role = 'intake' AND client_id IS NULL))
);

CREATE TABLE tender_desk.pricing_holds (
  tender_no text PRIMARY KEY,
  client_id uuid NOT NULL REFERENCES tender_desk.clients (id),
  state text NOT NULL DEFAULT 'held' CHECK (state IN ('held', 'stopped')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tender_desk.stats_snapshots (
  client_id uuid NOT NULL REFERENCES tender_desk.clients (id),
  tender_no text NOT NULL,
  stat_id text NOT NULL,
  snapshot jsonb NOT NULL,
  PRIMARY KEY (client_id, tender_no, stat_id)
);

CREATE TABLE tender_desk.shortlists (
  client_id uuid NOT NULL REFERENCES tender_desk.clients (id),
  tender_no text NOT NULL,
  fit_score integer NOT NULL CHECK (fit_score BETWEEN 0 AND 100),
  reasons text[] NOT NULL,
  PRIMARY KEY (client_id, tender_no)
);

CREATE TABLE tender_desk.briefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES tender_desk.clients (id),
  tender_no text NOT NULL,
  stat_id text NOT NULL,
  recommendation text NOT NULL CHECK (recommendation IN ('bid', 'no-bid')),
  content text NOT NULL,
  credentials_cited uuid[] NOT NULL,
  price_band jsonb,
  flags text[] NOT NULL,
  status text NOT NULL CHECK (status IN ('pending_approval', 'approved', 'declined')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (client_id, tender_no, stat_id)
    REFERENCES tender_desk.stats_snapshots (client_id, tender_no, stat_id)
);

CREATE TABLE tender_desk.conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_no text NOT NULL,
  client_id uuid NOT NULL REFERENCES tender_desk.clients (id),
  holder_client_id uuid NOT NULL REFERENCES tender_desk.clients (id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tender_no, client_id)
);

CREATE TABLE tender_desk.audit_log (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  action text NOT NULL,
  client_id uuid,
  tender_no text,
  outcome text NOT NULL CHECK (outcome IN ('allowed', 'blocked', 'escalated', 'approved', 'declined')),
  rule_id text,
  reason text NOT NULL,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Statement triggers also reject empty-target mutations and owner-issued SQL.
-- These are app guardrails; a DBA can still disable or drop the triggers.
CREATE FUNCTION tender_desk.reject_immutable_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER audit_log_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON tender_desk.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION tender_desk.reject_immutable_mutation();

CREATE TRIGGER stats_snapshots_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON tender_desk.stats_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION tender_desk.reject_immutable_mutation();

REVOKE ALL ON SCHEMA tender_desk FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA tender_desk FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA tender_desk FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA tender_desk FROM PUBLIC;

COMMIT;
