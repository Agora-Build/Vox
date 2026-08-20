-- Rename the secret_class enum value 'login' → 'protected'.
-- Postgres renames the value in place; existing rows keep their identity, and
-- the type name (secret_class) and column name (class) are unchanged.
ALTER TYPE secret_class RENAME VALUE 'login' TO 'protected';
