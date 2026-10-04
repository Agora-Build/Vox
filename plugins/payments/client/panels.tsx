import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Button, Badge, Input, Label, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, apiRequest, queryClient } from "@vox/web-plugin-sdk";

export interface Billing {
  catalog: { version: number; premiumPriceCents: number; topupPriceCents: number; topupCredits: number };
  paymentsEnabled: boolean;
  subscription: { status: string; paid_through: string | null; cancel_at_period_end: boolean; price_cents: number } | null;
  purchases: Array<{ id: string; kind: string; amount_cents: number; credits: number; status: string; created_at: string }>;
}
export function money(cents: number) { return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(cents / 100); }
export function useBilling() {
  const [poll, setPoll] = useState(() => new URLSearchParams(window.location.search).has("checkout"));
  useEffect(() => { const timer = setTimeout(() => setPoll(false), 60_000); return () => clearTimeout(timer); }, []);
  return useQuery<Billing>({ queryKey: ["/api/plugins/payments/usage"], refetchInterval: poll ? 3000 : false });
}
function BillingUnavailableNotice() {
  return <p role="status" className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">Stripe is not configured. Personal top-ups, subscriptions, and payment-method updates are disabled.</p>;
}
function useRedirect() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const redirect = async (path: string, body: unknown = {}) => {
    setBusy(true); setError("");
    try {
      const { url } = await (await apiRequest("POST", path, body)).json();
      const target = new URL(url);
      if (target.protocol !== "https:" || !["checkout.stripe.com", "billing.stripe.com"].includes(target.hostname)) throw new Error("Invalid Stripe destination");
      window.location.assign(url);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return { busy, error, redirect };
}
export function TopupPanel() {
  const billing = useBilling();
  const [packs, setPacks] = useState("1");
  const requestId = useRef(crypto.randomUUID());
  const checkout = useRedirect();
  const quantity = Number(packs);
  const data = billing.data;
  if (billing.isLoading) return <p>Loading credit packs...</p>;
  if (!data || billing.isError) return <p role="alert">Could not load credit packs.</p>;
  return <Card><CardHeader><CardTitle>Keep building</CardTitle><CardDescription>{data.catalog.topupCredits} credits for {money(data.catalog.topupPriceCents)}. Available on Basic too, with no subscription required.</CardDescription></CardHeader><CardContent className="space-y-4">
    <div className="flex flex-wrap items-end gap-4"><div className="space-y-2"><Label htmlFor="topup-packs">Credit packs</Label><Input id="topup-packs" type="number" min="1" max="20" className="w-24" value={packs} disabled={checkout.busy} onChange={(e) => { setPacks(e.target.value); requestId.current = crypto.randomUUID(); }} /></div>
      <Button disabled={!data.paymentsEnabled || checkout.busy || !Number.isInteger(quantity) || quantity < 1 || quantity > 20} onClick={() => checkout.redirect("/api/plugins/payments/checkout", { requestId: requestId.current, kind: "topup", packs: quantity })}>
        {checkout.busy ? "Opening Stripe..." : Number.isInteger(quantity) && quantity > 0 && quantity <= 20 ? `Buy ${(quantity * data.catalog.topupCredits).toLocaleString()} credits \u00b7 ${money(quantity * data.catalog.topupPriceCents)}` : "Choose 1-20 packs"}
      </Button>
    </div><p className="text-xs text-muted-foreground">One-time payment through Stripe. Credits never expire. Prices are in USD.</p>
    {!data.paymentsEnabled && <BillingUnavailableNotice />}
    {checkout.error && <p role="alert" className="text-sm text-destructive">{checkout.error}</p>}
  </CardContent></Card>;
}
export function PlanPanel() {
  const billing = useBilling();
  const auth = useQuery<{ user: { plan: string } | null }>({ queryKey: ["/api/auth/status"] });
  const action = useRedirect();
  const data = billing.data;
  const paidUntil = data?.subscription?.paid_through;
  useEffect(() => { if (paidUntil) queryClient.invalidateQueries({ queryKey: ["/api/auth/status"] }); }, [paidUntil]);
  if (billing.isLoading || auth.isLoading) return <p>Loading your plan...</p>;
  if (!data || billing.isError) return <p role="alert">Could not load your personal plan.</p>;
  if (!auth.data?.user || auth.isError) return <p role="alert">Could not load your current account access.</p>;
  // Core resolves effective access without replacing assigned Principal/Fellow tiers.
  const accountPlan = auth.data.user.plan;
  const accountPlanLabel = accountPlan.charAt(0).toUpperCase() + accountPlan.slice(1);
  const active = !!paidUntil && new Date(paidUntil).getTime() > Date.now();
  return <div className="space-y-6">
    {!data.paymentsEnabled && <BillingUnavailableNotice />}
    <Card data-testid="personal-account-plan"><CardHeader><CardDescription>Current account access</CardDescription><CardTitle className="text-2xl">{accountPlanLabel}</CardTitle></CardHeader><CardContent className="space-y-3">
      {accountPlan === "basic" ? <p>Basic is free. Top up credits whenever you need them.</p>
        : accountPlan === "premium" && active ? <p>Premium features are included with your active personal subscription.</p>
        : <p>Your {accountPlanLabel} access does not require a paid personal subscription.</p>}
      <div className="space-y-2 rounded-md border bg-muted/30 p-3" data-testid="personal-subscription">
        <p className="text-sm font-medium">Personal billing subscription</p>
        <p>{active ? `Premium \u00b7 ${money(data.subscription!.price_cents)} / month` : "No active paid subscription"}</p>
        {paidUntil && <p className="text-sm text-muted-foreground">{data.subscription?.cancel_at_period_end ? "Subscription paid until" : "Paid through"} {new Date(paidUntil).toLocaleDateString()} &middot; {data.subscription?.status}</p>}
      </div>
      {data.subscription && <Button variant="outline" disabled={!data.paymentsEnabled || action.busy} onClick={() => action.redirect("/api/plugins/payments/portal")}>Manage subscription &amp; billing</Button>}
    </CardContent></Card>
    <div className="grid gap-4 md:grid-cols-2">
      <Card><CardHeader><CardTitle>Basic</CardTitle><div className="font-mono text-3xl">$0 <span className="font-sans text-sm text-muted-foreground">/ free</span></div></CardHeader><CardContent className="space-y-2 text-sm"><p>Public evaluation resources</p><p>100 welcome credits, once per user</p><p>Buy credit packs without subscribing</p></CardContent></Card>
      <Card className="border-primary/30 bg-gradient-to-br from-primary/5 to-background"><CardHeader><div className="flex items-center justify-between"><CardTitle>Premium</CardTitle>{active && <Badge>Current subscription</Badge>}</div><div className="font-mono text-3xl">{money(data.catalog.premiumPriceCents)} <span className="font-sans text-sm text-muted-foreground">/ month</span></div></CardHeader><CardContent className="space-y-3 text-sm"><p>Private evaluation flows and sets</p><p>Your own storage and recording analysis</p><p>Private evaluation agents</p><p className="text-muted-foreground">Feature access only. No recurring credits. Your existing credits stay yours.</p>
        {!active && accountPlan === "basic" && <Button disabled={!data.paymentsEnabled || action.busy} onClick={() => action.redirect("/api/plugins/payments/checkout", { requestId: crypto.randomUUID(), kind: "premium", packs: 1 })}>{action.busy ? "Opening Stripe..." : "Upgrade to Premium"}</Button>}
      </CardContent></Card>
    </div>
    {action.error && <p role="alert" className="text-sm text-destructive">{action.error}</p>}
    <Card><CardHeader><CardTitle>Personal purchases</CardTitle><CardDescription>Recent Stripe purchases. Organization invoices are separate.</CardDescription></CardHeader><CardContent><Table><TableHeader><TableRow><TableHead>Purchase</TableHead><TableHead>Date</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Amount</TableHead></TableRow></TableHeader><TableBody>{data.purchases.map((purchase) => <TableRow key={purchase.id}><TableCell>{purchase.kind === "topup" ? `${purchase.credits.toLocaleString()} credits` : "Premium subscription"}</TableCell><TableCell>{new Date(purchase.created_at).toLocaleDateString()}</TableCell><TableCell>{purchase.status === "review" ? "Refund/dispute review" : purchase.status}</TableCell><TableCell className="text-right">{money(purchase.amount_cents)}</TableCell></TableRow>)}</TableBody></Table>{!data.purchases.length && <p className="mt-3 text-sm text-muted-foreground">No personal purchases yet.</p>}</CardContent></Card>
  </div>;
}
