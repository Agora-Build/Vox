/**
 * Stripe integration service
 *
 * Optional - system works without Stripe for testing.
 * Set STRIPE_SECRET_KEY environment variable to enable.
 */

export interface StripeCustomerResult {
  id: string;
}

export interface StripeSetupIntentResult {
  clientSecret: string;
  id: string;
}

export interface StripePaymentIntentResult {
  id: string;
  status: string;
  clientSecret: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let stripe: any = null;

async function getStripe() {
  if (!stripe && process.env.STRIPE_SECRET_KEY) {
    try {
      const Stripe = (await import("stripe")).default;
      stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    } catch {
      console.warn("Stripe module not available");
    }
  }
  return stripe;
}

/**
 * Check if Stripe is configured
 */
export function isStripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

/**
 * Check if using Stripe test keys (allows test mode purchases)
 */
export function isStripeTestMode(): boolean {
  const secretKey = process.env.STRIPE_SECRET_KEY || "";
  return secretKey.startsWith("sk_test_");
}

/**
 * Create a Stripe customer
 */
export async function createStripeCustomer(
  email: string,
  name: string,
  metadata?: Record<string, string>
): Promise<StripeCustomerResult | null> {
  const stripeClient = await getStripe();
  if (!stripeClient) return null;

  const customer = await stripeClient.customers.create({
    email,
    name,
    metadata,
  });

  return { id: customer.id };
}

/**
 * Create a setup intent for adding a payment method
 */
export async function createSetupIntent(customerId: string): Promise<StripeSetupIntentResult | null> {
  const stripeClient = await getStripe();
  if (!stripeClient) return null;

  const setupIntent = await stripeClient.setupIntents.create({
    customer: customerId,
    payment_method_types: ["card"],
  });

  return {
    clientSecret: setupIntent.client_secret,
    id: setupIntent.id,
  };
}

/**
 * Create a payment intent for processing a payment
 */
export async function createPaymentIntent(
  customerId: string,
  amount: number, // in cents
  paymentMethodId: string,
  description: string
): Promise<StripePaymentIntentResult | null> {
  const stripeClient = await getStripe();
  if (!stripeClient) return null;

  const paymentIntent = await stripeClient.paymentIntents.create({
    amount,
    currency: "usd",
    customer: customerId,
    payment_method: paymentMethodId,
    description,
    confirm: true,
    return_url: `${process.env.APP_URL || "http://localhost:5000"}/console/organization/billing`,
  });

  return {
    id: paymentIntent.id,
    status: paymentIntent.status,
    clientSecret: paymentIntent.client_secret,
  };
}

/**
 * Retrieve a payment method's details
 */
export async function getPaymentMethodDetails(paymentMethodId: string): Promise<{
  lastFour: string;
  expiryMonth: number;
  expiryYear: number;
} | null> {
  const stripeClient = await getStripe();
  if (!stripeClient) return null;

  const paymentMethod = await stripeClient.paymentMethods.retrieve(paymentMethodId);

  if (!paymentMethod.card) return null;

  return {
    lastFour: paymentMethod.card.last4,
    expiryMonth: paymentMethod.card.exp_month,
    expiryYear: paymentMethod.card.exp_year,
  };
}

/**
 * Attach a payment method to a customer
 */
export async function attachPaymentMethod(
  paymentMethodId: string,
  customerId: string
): Promise<boolean> {
  const stripeClient = await getStripe();
  if (!stripeClient) return false;

  await stripeClient.paymentMethods.attach(paymentMethodId, {
    customer: customerId,
  });

  return true;
}

/**
 * Detach a payment method
 */
export async function detachPaymentMethod(paymentMethodId: string): Promise<boolean> {
  const stripeClient = await getStripe();
  if (!stripeClient) return false;

  await stripeClient.paymentMethods.detach(paymentMethodId);
  return true;
}

/**
 * Verify and construct a Stripe webhook event
 */
export async function constructWebhookEvent(
  payload: string | Buffer,
  signature: string
): Promise<{ type: string; data: { object: Record<string, unknown> } } | null> {
  const stripeClient = await getStripe();
  if (!stripeClient) return null;

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.warn("STRIPE_WEBHOOK_SECRET not configured");
    return null;
  }

  try {
    const event = stripeClient.webhooks.constructEvent(payload, signature, webhookSecret);
    return event;
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return null;
  }
}

/**
 * Get Stripe publishable key for frontend
 */
export function getStripePublishableKey(): string | null {
  return process.env.STRIPE_PUBLISHABLE_KEY || null;
}
