BEGIN;

-- Readable references (CLI00001, PRJ00001, BRF00001, CON00001). Existing rows are
-- numbered in creation order before the column becomes required.
CREATE SEQUENCE tender_desk.client_ref_seq AS bigint;
CREATE SEQUENCE tender_desk.project_ref_seq AS bigint;
CREATE SEQUENCE tender_desk.brief_ref_seq AS bigint;
CREATE SEQUENCE tender_desk.conflict_ref_seq AS bigint;

ALTER TABLE tender_desk.clients ADD COLUMN reference_number bigint;
UPDATE tender_desk.clients c SET reference_number = n.rn
  FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn FROM tender_desk.clients) n WHERE c.id = n.id;
SELECT setval('tender_desk.client_ref_seq', COALESCE((SELECT max(reference_number) FROM tender_desk.clients), 0) + 1, false);
ALTER TABLE tender_desk.clients ALTER COLUMN reference_number SET DEFAULT nextval('tender_desk.client_ref_seq'),
  ALTER COLUMN reference_number SET NOT NULL, ADD UNIQUE (reference_number);

ALTER TABLE tender_desk.projects ADD COLUMN reference_number bigint,
  ADD COLUMN gebiz_tender_no text CHECK (gebiz_tender_no IS NULL OR length(btrim(gebiz_tender_no)) BETWEEN 1 AND 100),
  ADD COLUMN verification_note text CHECK (verification_note IS NULL OR length(verification_note) <= 500),
  ADD COLUMN verified_at timestamptz;
UPDATE tender_desk.projects p SET reference_number = n.rn
  FROM (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM tender_desk.projects) n WHERE p.id = n.id;
SELECT setval('tender_desk.project_ref_seq', COALESCE((SELECT max(reference_number) FROM tender_desk.projects), 0) + 1, false);
ALTER TABLE tender_desk.projects ALTER COLUMN reference_number SET DEFAULT nextval('tender_desk.project_ref_seq'),
  ALTER COLUMN reference_number SET NOT NULL, ADD UNIQUE (reference_number);

ALTER TABLE tender_desk.briefs ADD COLUMN reference_number bigint,
  ADD COLUMN risk_facts jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN risk_level text NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low', 'medium', 'high')),
  ADD COLUMN decided_at timestamptz,
  ADD COLUMN decline_reason text CHECK (decline_reason IS NULL OR length(decline_reason) <= 500);
UPDATE tender_desk.briefs b SET reference_number = n.rn
  FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn FROM tender_desk.briefs) n WHERE b.id = n.id;
SELECT setval('tender_desk.brief_ref_seq', COALESCE((SELECT max(reference_number) FROM tender_desk.briefs), 0) + 1, false);
ALTER TABLE tender_desk.briefs ALTER COLUMN reference_number SET DEFAULT nextval('tender_desk.brief_ref_seq'),
  ALTER COLUMN reference_number SET NOT NULL, ADD UNIQUE (reference_number);

ALTER TABLE tender_desk.conflicts ADD COLUMN reference_number bigint;
UPDATE tender_desk.conflicts c SET reference_number = n.rn
  FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn FROM tender_desk.conflicts) n WHERE c.id = n.id;
SELECT setval('tender_desk.conflict_ref_seq', COALESCE((SELECT max(reference_number) FROM tender_desk.conflicts), 0) + 1, false);
ALTER TABLE tender_desk.conflicts ALTER COLUMN reference_number SET DEFAULT nextval('tender_desk.conflict_ref_seq'),
  ALTER COLUMN reference_number SET NOT NULL, ADD UNIQUE (reference_number);

ALTER TABLE tender_desk.agent_credentials ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

REVOKE ALL ON ALL SEQUENCES IN SCHEMA tender_desk FROM PUBLIC;

COMMIT;
