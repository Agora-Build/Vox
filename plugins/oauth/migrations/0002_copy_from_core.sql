-- One-shot copy of existing account links from Core's public.users.github_id /
-- public.users.google_id into this plugin's identities table.
--
-- Runs inside the plugin-migration transaction with
-- `SET LOCAL search_path TO "<schema>", public`, so unqualified names resolve to
-- this plugin's schema and `public.`-qualified names to Core. A RAISE EXCEPTION
-- aborts the transaction and the app refuses to start: a partial copy must never
-- become the source of truth for who can sign in as whom.
--
-- Core's columns are each UNIQUE, so they map 1:1 onto (provider, subject) and
-- (provider, user_id) without conflicts. Core stops reading and writing them in
-- the same release; they are dropped in a later one.
--
-- A sign-in handled by the old container after this copy commits is not lost for
-- good: the next sign-in finds the user by email and links them again.
DO $$
DECLARE
  has_github boolean;
  has_google boolean;
  core_github integer;
  core_google integer;
  copied_github integer;
  copied_google integer;
BEGIN
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'github_id')
    INTO has_github;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'google_id')
    INTO has_google;
  IF NOT has_github AND NOT has_google THEN
    RAISE NOTICE 'oauth copy: no public.users.github_id / google_id — fresh install, nothing to copy';
    RETURN;
  END IF;
  -- Only one of the pair present is not a state any Core release produced;
  -- skipping would silently drop the other provider's links.
  IF has_github <> has_google THEN
    RAISE EXCEPTION 'oauth copy: public.users has only one of github_id / google_id — inconsistent Core schema, refusing to copy';
  END IF;
  IF EXISTS (SELECT 1 FROM identities) THEN
    RAISE EXCEPTION 'oauth copy: identities already populated — refusing to re-copy';
  END IF;

  INSERT INTO identities (provider, subject, user_id)
  SELECT 'github', github_id, id FROM public.users WHERE github_id IS NOT NULL;

  INSERT INTO identities (provider, subject, user_id)
  SELECT 'google', google_id, id FROM public.users WHERE google_id IS NOT NULL;

  SELECT count(*) INTO core_github FROM public.users WHERE github_id IS NOT NULL;
  SELECT count(*) INTO core_google FROM public.users WHERE google_id IS NOT NULL;
  SELECT count(*) INTO copied_github FROM identities WHERE provider = 'github';
  SELECT count(*) INTO copied_google FROM identities WHERE provider = 'google';

  IF core_github <> copied_github OR core_google <> copied_google THEN
    RAISE EXCEPTION 'oauth copy: count mismatch — github core=% copied=%, google core=% copied=%',
      core_github, copied_github, core_google, copied_google;
  END IF;

  -- Value-level check: every Core link has an identical plugin row.
  IF EXISTS (
    SELECT 1 FROM public.users u
    WHERE (u.github_id IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM identities i WHERE i.provider = 'github' AND i.subject = u.github_id AND i.user_id = u.id))
       OR (u.google_id IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM identities i WHERE i.provider = 'google' AND i.subject = u.google_id AND i.user_id = u.id))
  ) THEN
    RAISE EXCEPTION 'oauth copy: a copied link does not match its Core source';
  END IF;

  RAISE NOTICE 'oauth copy: % github and % google links copied', copied_github, copied_google;
END $$;
