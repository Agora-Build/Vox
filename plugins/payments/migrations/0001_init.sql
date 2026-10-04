CREATE TABLE catalog_versions (
  id serial PRIMARY KEY,
  premium_price_cents integer NOT NULL CHECK(premium_price_cents>0),
  topup_price_cents integer NOT NULL CHECK(topup_price_cents>0),
  topup_credits integer NOT NULL CHECK(topup_credits>0),
  premium_stripe_price text,
  topup_stripe_price text,
  admin_user_id integer,
  verification_receipt text,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO catalog_versions(premium_price_cents,topup_price_cents,topup_credits) VALUES(1200,500,100);
--> statement-breakpoint
CREATE TABLE customers (
  user_ref integer PRIMARY KEY,
  stripe_customer_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE purchases (
  id uuid PRIMARY KEY,
  user_ref integer NOT NULL,
  kind text NOT NULL CHECK(kind IN ('topup','premium')),
  packs integer NOT NULL DEFAULT 1,
  catalog_version integer NOT NULL REFERENCES catalog_versions(id),
  amount_cents integer NOT NULL,
  credits integer NOT NULL,
  stripe_checkout_id text UNIQUE,
  stripe_payment_intent text UNIQUE,
  stripe_subscription_id text,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','expired','review')),
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);
--> statement-breakpoint
CREATE TABLE subscriptions (
  user_ref integer PRIMARY KEY,
  stripe_subscription_id text NOT NULL UNIQUE,
  status text NOT NULL,
  paid_through timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  price_cents integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE webhook_events (
  id text PRIMARY KEY,
  event_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
--> statement-breakpoint
CREATE TABLE payment_reviews (
  event_id text PRIMARY KEY,
  user_ref integer NOT NULL,
  purchase_id uuid,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
