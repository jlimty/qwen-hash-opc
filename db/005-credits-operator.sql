BEGIN;

-- Credits replace per-brief payments; the admin's QwenWork gets an operator role that can prepare but never decide.

ALTER TABLE tender_desk.agent_credentials DROP CONSTRAINT agent_credentials_role_check,
  DROP CONSTRAINT agent_credentials_check;
ALTER TABLE tender_desk.agent_credentials
  ADD CONSTRAINT agent_credentials_role_check CHECK (role IN ('client', 'intake', 'operator')),
  ADD CONSTRAINT agent_credentials_check CHECK ((role = 'client' AND client_id IS NOT NULL) OR (role IN ('intake', 'operator') AND client_id IS NULL));

CREATE TABLE tender_desk.credit_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES tender_desk.clients (id),
  credits integer NOT NULL CHECK (credits > 0 AND credits <= 1000),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 9007199254740991),
  currency text NOT NULL DEFAULT 'SGD' CHECK (currency = 'SGD'),
  status text NOT NULL CHECK (status IN ('test', 'paid', 'refunded')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per change to a client's credits; the balance is the sum.
CREATE TABLE tender_desk.credit_ledger (
  id bigserial PRIMARY KEY,
  client_id uuid NOT NULL REFERENCES tender_desk.clients (id),
  delta integer NOT NULL CHECK (delta <> 0 AND delta BETWEEN -1000 AND 1000),
  reason text NOT NULL CHECK (reason IN ('welcome', 'purchase', 'brief', 'refund', 'adjustment')),
  request_id uuid REFERENCES tender_desk.brief_requests (id),
  purchase_id uuid REFERENCES tender_desk.credit_purchases (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_ledger_client ON tender_desk.credit_ledger (client_id);

-- Suggestions from the admin's AI reviewer. Never a decision.
CREATE TABLE tender_desk.review_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject text NOT NULL CHECK (subject IN ('brief', 'request', 'project')),
  subject_id uuid NOT NULL,
  author text NOT NULL CHECK (length(author) BETWEEN 1 AND 100),
  note text NOT NULL CHECK (length(btrim(note)) BETWEEN 1 AND 2000),
  suggested_action text CHECK (suggested_action IN ('approve', 'redraft', 'ask_for_more', 'decline', 'verify', 'do_not_verify')),
  redraft_note text CHECK (redraft_note IS NULL OR length(redraft_note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_notes_subject ON tender_desk.review_notes (subject, subject_id);

-- revision counts edits to a pending brief, so an approval can name the exact version the admin read.
ALTER TABLE tender_desk.briefs ADD COLUMN parts jsonb, ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0);
-- One company per UEN, so the welcome credit can't be farmed with new accounts. Older companies may have none.
ALTER TABLE tender_desk.clients ADD COLUMN uen text CHECK (uen IS NULL OR uen ~ '^[0-9A-Z]{9,10}$');
CREATE UNIQUE INDEX clients_uen ON tender_desk.clients (uen) WHERE uen IS NOT NULL;
-- A hold ends when the tender closes (or after a fixed time for a pasted tender with no closing date).
ALTER TABLE tender_desk.pricing_holds ADD COLUMN expires_at timestamptz;
-- "Ask for more": the admin asks the client for missing information instead of declining. The tender stays held and
-- the credit stays spent; the client resubmits for free, or cancels for a refund.
ALTER TABLE tender_desk.brief_requests DROP CONSTRAINT brief_requests_status_check,
  ADD CONSTRAINT brief_requests_status_check CHECK (status IN ('requested', 'drafted', 'needs_info', 'approved', 'declined', 'cancelled')),
  ADD COLUMN info_request text CHECK (info_request IS NULL OR length(info_request) <= 500),
  ADD COLUMN resubmitted_at timestamptz,
  ADD COLUMN info_due_at timestamptz;
DROP INDEX tender_desk.brief_requests_one_active;
CREATE UNIQUE INDEX brief_requests_one_active ON tender_desk.brief_requests (client_id, tender_no) WHERE status IN ('requested', 'drafted', 'needs_info');
ALTER TABLE tender_desk.brief_requests ADD COLUMN requirements_text text CHECK (requirements_text IS NULL OR length(requirements_text) <= 4000);

INSERT INTO tender_desk.settings (key, value) VALUES ('credit_price_cents', '2900'), ('credits_per_brief', '1'),
  ('welcome_credits', '1'), ('credit_packs', '5:11900,20:39900') ON CONFLICT (key) DO NOTHING;

REVOKE ALL ON ALL TABLES IN SCHEMA tender_desk FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA tender_desk FROM PUBLIC;

COMMIT;
