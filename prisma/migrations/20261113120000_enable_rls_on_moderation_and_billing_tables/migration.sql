-- Enable Row Level Security on the tables added by the video webhook, billing and moderation
-- migrations, matching every other table in the public schema (defense in depth for the
-- Supabase Data API). No policies are created: API roles stay default-deny. RLS is NOT forced,
-- so the table owner used by the application and Prisma migrations is unaffected.
ALTER TABLE "AbuseReport" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ModerationAuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentAttempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentOrder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentWebhookEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProviderWebhookEvent" ENABLE ROW LEVEL SECURITY;
