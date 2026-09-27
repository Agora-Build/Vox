-- One row per external account linked to a Vox user. user_id is a Core user id,
-- held as an opaque integer (no FK across schemas, same as organizations).
CREATE TABLE identities (
  provider   text        NOT NULL CHECK (provider IN ('github', 'google')),
  subject    text        NOT NULL,
  user_id    integer     NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject),
  UNIQUE (provider, user_id)
);
