ALTER TABLE payment_reviews ADD COLUMN stripe_payment_intent text;
--> statement-breakpoint
CREATE INDEX payment_reviews_intent_idx ON payment_reviews(stripe_payment_intent);
