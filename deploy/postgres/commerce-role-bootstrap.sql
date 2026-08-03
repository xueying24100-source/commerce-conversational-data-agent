-- Run as a PostgreSQL administrator before migrations. Passwords are assigned
-- through the platform secret manager, never committed to this file.

DO $$
DECLARE
  role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'commerce_migration_user',
    'commerce_control_user',
    'commerce_readonly_user',
    'commerce_ingest_user',
    'commerce_maintenance_user',
    'commerce_backup_user'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format(
        'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
        role_name
      );
    END IF;
  END LOOP;
END $$;

ALTER ROLE commerce_readonly_user SET default_transaction_read_only = on;
ALTER ROLE commerce_backup_user SET default_transaction_read_only = on;
ALTER ROLE commerce_backup_user BYPASSRLS;

-- The migration role should own each target database and its public schema.
-- Execute the following in each database after replacing the database name:
-- ALTER DATABASE commerce_agent OWNER TO commerce_migration_user;
-- ALTER SCHEMA public OWNER TO commerce_migration_user;
