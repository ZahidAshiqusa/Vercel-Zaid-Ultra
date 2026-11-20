-- ============================================================================
-- Supabase Session Persistence Schema for Vercel WhatsApp Bot Deployment
-- Run once in Supabase -> SQL Editor if using SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
-- (If you also set SUPABASE_DB_URL in Vercel, tables are created automatically.)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.auth_creds (
    "sessionId" VARCHAR(64) PRIMARY KEY,
    data TEXT NOT NULL,
    "sessionToken" TEXT,
    "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.auth_keys (
    "sessionId" VARCHAR(64) NOT NULL,
    type VARCHAR(32) NOT NULL,
    "keyId" VARCHAR(128) NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY ("sessionId", type, "keyId")
);

CREATE INDEX IF NOT EXISTS idx_auth_keys_session ON public.auth_keys ("sessionId");
CREATE INDEX IF NOT EXISTS idx_auth_creds_updated ON public.auth_creds ("updatedAt" DESC);
