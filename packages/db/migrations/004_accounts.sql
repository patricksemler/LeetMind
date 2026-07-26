-- 004_accounts.sql
--
-- Real accounts. Authentication itself lives in Supabase Auth (a separate Postgres, reached only
-- via a verified JWT) — this database never stores a password, a password hash, or a session. All
-- it keeps is the binding between a Supabase auth subject and the local `users` row that owns the
-- practice history, so every existing `user_id` foreign key keeps working untouched.
--
-- `users.id` deliberately stays a locally-minted ULID rather than becoming the Supabase UUID:
-- every table in the schema already references it, ids appear in logs and correlation traces, and
-- an account could in principle be re-bound to a different auth provider later without rewriting
-- a dozen foreign keys.

alter table users add column auth_user_id text unique;
alter table users add column email text;

-- `handle` predates accounts and is still `not null unique`; new rows derive it from the email
-- local part (uniquified on collision) in @leetmind/db's `provisionUserForAuth`.
comment on column users.auth_user_id is
  'Supabase Auth subject (JWT `sub`). Null for the legacy pre-accounts single-user row until claimed.';
comment on column users.email is
  'Denormalized from the JWT for display only; Supabase Auth remains the source of truth.';
