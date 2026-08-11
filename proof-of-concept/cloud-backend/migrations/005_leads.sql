-- Phase 1 of the self-serve single-matter signup flow (marketing site ->
-- email capture -> Stripe payment -> matter activation). This table exists
-- entirely before any organization/user exists for the lead, so unlike
-- everything else in this schema it is NOT RLS-protected — same rationale
-- as the `jobs` queue in 002_documents.sql: it is never queried by any
-- tenant-facing route, only by the public capture endpoint (insert) and a
-- platform-admin-only listing route (read), both trusted system code.

CREATE TABLE leads (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                    TEXT NOT NULL,
  contact_name             TEXT NOT NULL,
  firm_name                TEXT NOT NULL,
  -- captured: form submitted, not yet paid.
  -- paid: Stripe payment confirmed, org/matter not yet provisioned.
  -- provisioned: organization_id is set, the firm's matter is live.
  status                   TEXT NOT NULL DEFAULT 'captured',
  stripe_checkout_session_id TEXT,
  stripe_payment_intent_id  TEXT,
  organization_id          UUID REFERENCES organizations(id),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at                  TIMESTAMPTZ,
  provisioned_at           TIMESTAMPTZ,
  CONSTRAINT leads_status_check CHECK (status IN ('captured', 'paid', 'provisioned', 'abandoned'))
);

CREATE INDEX idx_leads_email ON leads(email);
-- Phase 1's manual provisioning step is "find the leads not yet
-- provisioned" - a small, ever-shrinking set, so a partial index is enough.
CREATE INDEX idx_leads_pending ON leads(status) WHERE status != 'provisioned';
