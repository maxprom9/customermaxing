-- =============================================================================
-- CustomerMaxing.com — Supabase Schema
-- Prefix: cm_ (shared Supabase instance)
-- =============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
-- vector extension for future semantic search on knowledge base
CREATE EXTENSION IF NOT EXISTS "vector";

-- =============================================================================
-- TABLES
-- =============================================================================

-- Multi-tenant client organizations
CREATE TABLE cm_clients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    phone_number TEXT,                          -- Twilio number assigned to this client
    greeting_message TEXT DEFAULT 'Thank you for calling. How can I help you today?',
    ai_tone TEXT NOT NULL DEFAULT 'professional' CHECK (ai_tone IN ('professional', 'friendly', 'casual')),
    business_hours JSONB DEFAULT '{"monday":{"open":"09:00","close":"17:00"},"tuesday":{"open":"09:00","close":"17:00"},"wednesday":{"open":"09:00","close":"17:00"},"thursday":{"open":"09:00","close":"17:00"},"friday":{"open":"09:00","close":"17:00"},"saturday":null,"sunday":null}'::jsonb,
    max_hold_time_seconds INTEGER DEFAULT 300,
    escalation_rules JSONB DEFAULT '{"max_ai_turns": 10, "escalation_phrases": ["speak to a person", "talk to someone", "representative", "manager"]}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Portal users linked to clients (references auth.users)
CREATE TABLE cm_users (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    client_id UUID NOT NULL REFERENCES cm_clients(id) ON DELETE CASCADE,
    client_slug TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'manager', 'viewer')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Team members who receive calls before AI
CREATE TABLE cm_team_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES cm_clients(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    routing_order INTEGER NOT NULL DEFAULT 1,
    is_available BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- AI knowledge base entries
CREATE TABLE cm_knowledge_base (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES cm_clients(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'faq' CHECK (category IN ('faq', 'policies', 'procedures', 'contact_info', 'custom')),
    content TEXT NOT NULL,
    embedding vector(1536),                     -- For future semantic search
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Call log
CREATE TABLE cm_calls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES cm_clients(id) ON DELETE CASCADE,
    twilio_call_sid TEXT,
    caller_phone TEXT,
    caller_name TEXT,
    duration_seconds INTEGER,
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'missed', 'voicemail', 'transferred')),
    handled_by TEXT CHECK (handled_by IN ('ai', 'team_member')),
    handled_by_name TEXT,
    recording_url TEXT,
    transcript TEXT,
    ai_summary TEXT,
    satisfaction_score INTEGER CHECK (satisfaction_score IS NULL OR (satisfaction_score >= 1 AND satisfaction_score <= 5)),
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Individual messages in a call (detailed transcript)
CREATE TABLE cm_call_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    call_id UUID NOT NULL REFERENCES cm_calls(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('caller', 'ai', 'system')),
    content TEXT NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Client-specific key-value settings
CREATE TABLE cm_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES cm_clients(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value JSONB,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (client_id, key)
);

-- =============================================================================
-- INDEXES
-- =============================================================================

CREATE INDEX idx_cm_users_client_id ON cm_users(client_id);
CREATE INDEX idx_cm_users_client_slug ON cm_users(client_slug);

CREATE INDEX idx_cm_team_members_client_id ON cm_team_members(client_id);
CREATE INDEX idx_cm_team_members_routing ON cm_team_members(client_id, routing_order) WHERE is_available = true;

CREATE INDEX idx_cm_knowledge_base_client_id ON cm_knowledge_base(client_id);
CREATE INDEX idx_cm_knowledge_base_category ON cm_knowledge_base(client_id, category);

CREATE INDEX idx_cm_calls_client_id ON cm_calls(client_id);
CREATE INDEX idx_cm_calls_client_created ON cm_calls(client_id, created_at DESC);
CREATE INDEX idx_cm_calls_client_status ON cm_calls(client_id, status);
CREATE INDEX idx_cm_calls_twilio_sid ON cm_calls(twilio_call_sid);
CREATE INDEX idx_cm_calls_started_at ON cm_calls(started_at DESC);

CREATE INDEX idx_cm_call_messages_call_id ON cm_call_messages(call_id);

CREATE INDEX idx_cm_settings_client_id ON cm_settings(client_id);
CREATE INDEX idx_cm_settings_lookup ON cm_settings(client_id, key);

CREATE INDEX idx_cm_clients_phone ON cm_clients(phone_number);
CREATE INDEX idx_cm_clients_slug ON cm_clients(slug);

-- =============================================================================
-- ROW LEVEL SECURITY
-- =============================================================================

ALTER TABLE cm_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE cm_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE cm_team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE cm_knowledge_base ENABLE ROW LEVEL SECURITY;
ALTER TABLE cm_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE cm_call_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE cm_settings ENABLE ROW LEVEL SECURITY;

-- Helper: get current user's client_id
CREATE OR REPLACE FUNCTION cm_get_user_client_id()
RETURNS UUID AS $$
    SELECT client_id FROM cm_users WHERE id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- cm_clients: users can read their own client org
CREATE POLICY "cm_clients_select" ON cm_clients
    FOR SELECT USING (id = cm_get_user_client_id());

CREATE POLICY "cm_clients_update" ON cm_clients
    FOR UPDATE USING (id = cm_get_user_client_id())
    WITH CHECK (id = cm_get_user_client_id());

-- cm_users: users can read other users in their org
CREATE POLICY "cm_users_select" ON cm_users
    FOR SELECT USING (client_id = cm_get_user_client_id());

-- cm_team_members: full CRUD scoped to client
CREATE POLICY "cm_team_members_select" ON cm_team_members
    FOR SELECT USING (client_id = cm_get_user_client_id());

CREATE POLICY "cm_team_members_insert" ON cm_team_members
    FOR INSERT WITH CHECK (client_id = cm_get_user_client_id());

CREATE POLICY "cm_team_members_update" ON cm_team_members
    FOR UPDATE USING (client_id = cm_get_user_client_id())
    WITH CHECK (client_id = cm_get_user_client_id());

CREATE POLICY "cm_team_members_delete" ON cm_team_members
    FOR DELETE USING (client_id = cm_get_user_client_id());

-- cm_knowledge_base: full CRUD scoped to client
CREATE POLICY "cm_kb_select" ON cm_knowledge_base
    FOR SELECT USING (client_id = cm_get_user_client_id());

CREATE POLICY "cm_kb_insert" ON cm_knowledge_base
    FOR INSERT WITH CHECK (client_id = cm_get_user_client_id());

CREATE POLICY "cm_kb_update" ON cm_knowledge_base
    FOR UPDATE USING (client_id = cm_get_user_client_id())
    WITH CHECK (client_id = cm_get_user_client_id());

CREATE POLICY "cm_kb_delete" ON cm_knowledge_base
    FOR DELETE USING (client_id = cm_get_user_client_id());

-- cm_calls: read-only scoped to client
CREATE POLICY "cm_calls_select" ON cm_calls
    FOR SELECT USING (client_id = cm_get_user_client_id());

-- cm_call_messages: read-only scoped to client (via call)
CREATE POLICY "cm_call_messages_select" ON cm_call_messages
    FOR SELECT USING (
        call_id IN (SELECT id FROM cm_calls WHERE client_id = cm_get_user_client_id())
    );

-- cm_settings: full CRUD scoped to client
CREATE POLICY "cm_settings_select" ON cm_settings
    FOR SELECT USING (client_id = cm_get_user_client_id());

CREATE POLICY "cm_settings_insert" ON cm_settings
    FOR INSERT WITH CHECK (client_id = cm_get_user_client_id());

CREATE POLICY "cm_settings_update" ON cm_settings
    FOR UPDATE USING (client_id = cm_get_user_client_id())
    WITH CHECK (client_id = cm_get_user_client_id());

CREATE POLICY "cm_settings_delete" ON cm_settings
    FOR DELETE USING (client_id = cm_get_user_client_id());

-- =============================================================================
-- UPDATED_AT TRIGGER
-- =============================================================================

CREATE OR REPLACE FUNCTION cm_update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cm_clients_updated_at
    BEFORE UPDATE ON cm_clients
    FOR EACH ROW EXECUTE FUNCTION cm_update_updated_at();

CREATE TRIGGER cm_team_members_updated_at
    BEFORE UPDATE ON cm_team_members
    FOR EACH ROW EXECUTE FUNCTION cm_update_updated_at();

CREATE TRIGGER cm_knowledge_base_updated_at
    BEFORE UPDATE ON cm_knowledge_base
    FOR EACH ROW EXECUTE FUNCTION cm_update_updated_at();

CREATE TRIGGER cm_settings_updated_at
    BEFORE UPDATE ON cm_settings
    FOR EACH ROW EXECUTE FUNCTION cm_update_updated_at();

-- =============================================================================
-- SEED DATA
-- =============================================================================

INSERT INTO cm_clients (slug, name, phone_number, greeting_message, ai_tone)
VALUES (
    'grantmgmt',
    'Grant Management',
    '+18444847597',
    'Thank you for calling Grant Management. How can I assist you today?',
    'professional'
);
