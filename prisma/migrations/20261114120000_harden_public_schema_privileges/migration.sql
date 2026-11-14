-- Migration 10: row level security and privilege hardening for the public schema.
--
-- Supabase exposes the public schema through its Data API as the "anon" and "authenticated"
-- roles. The application never uses those roles: it connects as the table owner ("postgres",
-- BYPASSRLS), so nothing below changes what the application or Prisma can do. This migration
-- (1) enables RLS (not forced, no policies) on the original application tables, matching
-- migration 20261113120000 for the newer ones; (2) revokes every table and sequence privilege the
-- API roles hold on application objects and their EXECUTE on the application trigger function; and
-- (3) stops the migrating role's default privileges from granting future objects in public to them.
--
-- Deliberately NOT changed: USAGE on schema public (the Data API needs it to start, and it exposes
-- nothing once object privileges are gone); the service_role grants (out of scope for this change);
-- default privileges owned by roles the migrating role is not a member of (e.g. supabase_admin),
-- which are reported as a NOTICE instead. No data is read or written.
--
-- Safe to re-run, and safe where the Supabase roles do not exist (local and shadow databases):
-- role-dependent steps are skipped there. Any failed check raises and rolls the whole block back.

DO $$
DECLARE
  -- Every application table. The 12 original tables get RLS here; the other 6 already have it.
  app_tables CONSTANT text[] := ARRAY[
    'Account', 'CreditTransaction', 'CreditWallet', 'GeneratedAsset', 'GenerationJob',
    'ProviderBudgetReservation', 'ProviderDailyBudget', 'Session', 'UsageLog', 'User',
    'VerificationToken', '_prisma_migrations',
    'AbuseReport', 'ModerationAuditLog', 'PaymentAttempt', 'PaymentOrder',
    'PaymentWebhookEvent', 'ProviderWebhookEvent'];
  api_roles text[];
  grantees  text;
  t         text;
  r         text;
  o         record;
  bad       text[];
BEGIN
  -- Fail fast instead of queueing live traffic behind an ACCESS EXCLUSIVE lock (local to this transaction).
  PERFORM set_config('lock_timeout', '10s', true);

  -- 0. Preconditions: every table exists and the migrating role can alter it.
  SELECT array_agg(x) INTO bad FROM unnest(app_tables) x
  WHERE to_regclass(format('public.%I', x)) IS NULL;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'migration 10: application tables missing from schema public: %', bad;
  END IF;

  SELECT array_agg(x) INTO bad FROM unnest(app_tables) x
  JOIN pg_class c ON c.oid = to_regclass(format('public.%I', x))
  WHERE NOT pg_has_role(current_user, c.relowner, 'MEMBER');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'migration 10: % does not own (and is not a member of the owner of) %', current_user, bad;
  END IF;

  -- 1. RLS on (skipped where already on, so a re-run takes no table locks). Never FORCE.
  FOREACH t IN ARRAY app_tables LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass(format('public.%I', t))) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;

  -- Supabase Data API roles present on this server (none locally or in a shadow database).
  SELECT array_agg(x ORDER BY x) INTO api_roles
  FROM unnest(ARRAY['anon', 'authenticated']) x WHERE to_regrole(x) IS NOT NULL;

  IF api_roles IS NULL THEN
    RAISE NOTICE 'migration 10: roles anon/authenticated not present; privilege steps skipped';
  ELSE
    grantees := (SELECT string_agg(quote_ident(x), ', ') FROM unnest(api_roles) x);

    -- 2a. Existing objects: tables, any sequences in public, and the application trigger function.
    FOREACH t IN ARRAY app_tables LOOP
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %s', t, grantees);
    END LOOP;

    FOR o IN
      SELECT c.relname FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'S'
        AND pg_has_role(current_user, c.relowner, 'MEMBER')
    LOOP
      EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM %s', o.relname, grantees);
    END LOOP;

    -- A trigger function cannot be called directly and trigger firing does not check EXECUTE;
    -- PUBLIC is included because every role (anon included) inherits PUBLIC's grants.
    EXECUTE format('REVOKE ALL ON FUNCTION public.prevent_unsettled_reservation_delete() FROM PUBLIC, %s', grantees);

    -- 2b. Future objects: default privileges of the migrating role (and of "postgres" when the
    --     migrating role may act for it), schema-scoped and global.
    FOR r IN
      SELECT DISTINCT x FROM unnest(ARRAY[current_user::text, 'postgres']) x
      WHERE to_regrole(x) IS NOT NULL AND pg_has_role(current_user, x, 'MEMBER')
    LOOP
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM %s', r, grantees);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %s', r, grantees);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %s', r, grantees);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON TABLES FROM %s', r, grantees);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON SEQUENCES FROM %s', r, grantees);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON FUNCTIONS FROM %s', r, grantees);
    END LOOP;

    -- Default privileges this role cannot change (e.g. supabase_admin's): report, do not fail.
    FOR o IN
      SELECT DISTINCT pg_get_userbyid(d.defaclrole) AS owner
      FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
      WHERE (d.defaclnamespace = 'public'::regnamespace OR d.defaclnamespace = 0)
        AND a.grantee IN (SELECT oid FROM pg_roles WHERE rolname = ANY (api_roles))
        AND NOT pg_has_role(current_user, d.defaclrole, 'MEMBER')
    LOOP
      RAISE NOTICE 'migration 10: default privileges of role % still grant API roles and were not changed (% is not a member)', o.owner, current_user;
    END LOOP;
  END IF;

  -- 3. Self-checks. Any failure aborts the migration and rolls everything back.
  SELECT array_agg(x) INTO bad FROM unnest(app_tables) x
  JOIN pg_class c ON c.oid = to_regclass(format('public.%I', x))
  WHERE NOT c.relrowsecurity OR c.relforcerowsecurity;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'migration 10 check: RLS not enabled, or FORCE set, on %', bad;
  END IF;

  IF api_roles IS NOT NULL THEN
    SELECT array_agg(DISTINCT x) INTO bad FROM unnest(app_tables) x
    JOIN pg_class c ON c.oid = to_regclass(format('public.%I', x))
    CROSS JOIN unnest(api_roles) ar
    WHERE has_table_privilege(ar, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
       OR has_any_column_privilege(ar, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
       OR (current_setting('server_version_num')::int >= 170000
           AND has_table_privilege(ar, c.oid, 'MAINTAIN'));
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION 'migration 10 check: API roles still hold privileges on %', bad;
    END IF;

    SELECT array_agg(c.relname::text) INTO bad FROM pg_class c CROSS JOIN unnest(api_roles) ar
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'S'
      AND pg_has_role(current_user, c.relowner, 'MEMBER')
      AND has_sequence_privilege(ar, c.oid, 'USAGE, SELECT, UPDATE');
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION 'migration 10 check: API roles still hold privileges on sequences %', bad;
    END IF;

    IF EXISTS (SELECT 1 FROM unnest(api_roles) ar
               WHERE has_function_privilege(ar, 'public.prevent_unsettled_reservation_delete()', 'EXECUTE')) THEN
      RAISE EXCEPTION 'migration 10 check: API roles can still execute prevent_unsettled_reservation_delete()';
    END IF;

    SELECT array_agg(DISTINCT pg_get_userbyid(d.defaclrole)) INTO bad
    FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
    WHERE (d.defaclnamespace = 'public'::regnamespace OR d.defaclnamespace = 0)
      AND a.grantee IN (SELECT oid FROM pg_roles WHERE rolname = ANY (api_roles))
      AND pg_has_role(current_user, d.defaclrole, 'MEMBER');
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION 'migration 10 check: default privileges of % still grant API roles', bad;
    END IF;
  END IF;

  -- The owner keeps full DML (the application role is unaffected).
  SELECT array_agg(x) INTO bad FROM unnest(app_tables) x
  WHERE NOT (has_table_privilege(current_user, format('public.%I', x), 'SELECT')
         AND has_table_privilege(current_user, format('public.%I', x), 'INSERT')
         AND has_table_privilege(current_user, format('public.%I', x), 'UPDATE')
         AND has_table_privilege(current_user, format('public.%I', x), 'DELETE'));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'migration 10 check: % lost SELECT/INSERT/UPDATE/DELETE on %', current_user, bad;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = 'public."ProviderBudgetReservation"'::regclass
                   AND tgname = 'ProviderBudgetReservation_block_unsettled_delete'
                   AND tgenabled = 'O' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'migration 10 check: reservation delete trigger missing or disabled';
  END IF;
END $$;
