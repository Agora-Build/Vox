import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Button, Badge, Tabs, TabsList, TabsTrigger, TabsContent, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, PluginSlot } from "@vox/web-plugin-sdk";

interface Usage { available: number; reserved: number; spent: number; spentThisMonth: number }
interface Statement { entries: Array<{ id: number; amount: number; reason: string; refType: string | null; createdAt: string }>; nextCursor: string | null }
const labels: Record<string, string> = { welcome: "Welcome credits", topup: "Credit purchase", hold: "Reserved for a job", release: "Reservation released", capture: "Agent earnings", fee: "Platform fee" };

export default function UsagePage() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const tab = new URLSearchParams(search).get("tab") === "plan" ? "plan" : "credits";
  const [returning, setReturning] = useState(() => new URLSearchParams(window.location.search).has("checkout"));
  useEffect(() => { const timer = setTimeout(() => setReturning(false), 60_000); return () => clearTimeout(timer); }, []);
  const { data: auth } = useQuery<{ user: { plan: string; isAdmin: boolean } }>({ queryKey: ["/api/auth/status"] });
  const { data: usage, isLoading, isError } = useQuery<Usage>({ queryKey: ["/api/plugins/credits/usage"], refetchInterval: returning ? 3000 : false });
  const statement = useInfiniteQuery<Statement>({
    queryKey: ["personal-statement"], initialPageParam: null,
    queryFn: async ({ pageParam }) => {
      const res = await fetch(`/api/plugins/credits/statement?limit=25${pageParam ? `&cursor=${encodeURIComponent(String(pageParam))}` : ""}`, { credentials: "include" });
      if (!res.ok) throw new Error("Could not load credit history");
      return res.json();
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: returning ? 3000 : false,
  });
  return <div className="mx-auto max-w-5xl space-y-6">
    <div><Badge variant="outline">Personal account</Badge><h1 className="mt-3 text-3xl font-semibold tracking-tight">Usage</h1><p className="mt-2 text-muted-foreground">Your credits, activity and personal plan. Team billing stays in Organizations.</p></div>
    {returning && <p role="status" className="rounded-lg border bg-muted/40 p-3 text-sm">Back from Stripe. Your balance and plan update after payment confirmation; returning here does not grant credits.</p>}
    <Tabs value={tab} onValueChange={(value) => navigate(`/console/usage?tab=${value}`)}>
      <TabsList><TabsTrigger value="credits">Credits &amp; Usage</TabsTrigger><TabsTrigger value="plan">Plan</TabsTrigger></TabsList>
      <TabsContent value="credits" className="space-y-6 pt-4">
        {isError ? <p role="alert">Could not load your balance. Please refresh.</p> : <div className="grid gap-4 sm:grid-cols-3">
          <Card className="bg-gradient-to-br from-primary/10 via-background to-background"><CardHeader><CardDescription>Available credits</CardDescription><CardTitle data-testid="usage-available-credits" className="font-mono text-4xl tabular-nums">{isLoading ? "..." : usage?.available.toLocaleString()}</CardTitle></CardHeader><CardContent className="text-sm text-muted-foreground">100 welcome credits, once. Credits never expire.</CardContent></Card>
          <Card><CardHeader><CardDescription>Reserved for running jobs</CardDescription><CardTitle className="font-mono text-3xl tabular-nums">{usage?.reserved.toLocaleString() ?? "..."}</CardTitle></CardHeader><CardContent className="text-sm text-muted-foreground">Released if a job is refunded.</CardContent></Card>
          <Card><CardHeader><CardDescription>Spent this month</CardDescription><CardTitle className="font-mono text-3xl tabular-nums">{usage?.spentThisMonth.toLocaleString() ?? "..."}</CardTitle></CardHeader><CardContent className="text-sm text-muted-foreground">{usage?.spent.toLocaleString() ?? "..."} credits spent all time.</CardContent></Card>
        </div>}
        <PluginSlot name="personal-topup" fallback={<Card><CardHeader><CardTitle>Top up credits</CardTitle><CardDescription>Purchases are available when the payments plugin is enabled and Stripe is configured.</CardDescription></CardHeader></Card>} />
        <Card><CardHeader><CardTitle>Credit activity</CardTitle><CardDescription>Grants, purchases, reservations, refunds and agent earnings.</CardDescription></CardHeader><CardContent>
          {statement.isError ? <p role="alert">Could not load credit history.</p> : statement.isLoading ? <p>Loading activity...</p> : <Table><TableHeader><TableRow><TableHead>Activity</TableHead><TableHead>Date</TableHead><TableHead className="text-right">Credits</TableHead></TableRow></TableHeader><TableBody>
            {statement.data?.pages.flatMap((page) => page.entries).map((entry) => <TableRow key={entry.id}><TableCell>{entry.refType === "admin_grant" ? `Admin grant: ${entry.reason}` : labels[entry.reason] ?? entry.reason}</TableCell><TableCell className="text-muted-foreground">{new Date(entry.createdAt).toLocaleString()}</TableCell><TableCell className="text-right font-mono tabular-nums">{entry.amount > 0 ? "+" : ""}{entry.amount.toLocaleString()}</TableCell></TableRow>)}
          </TableBody></Table>}
          {statement.hasNextPage && <Button className="mt-4" variant="outline" disabled={statement.isFetchingNextPage} onClick={() => statement.fetchNextPage()}>Load more</Button>}
        </CardContent></Card>
      </TabsContent>
      <TabsContent value="plan" className="space-y-6 pt-4"><PluginSlot name="personal-plan" fallback={<Card><CardHeader><CardTitle>Current access: {auth?.user.plan ?? "Basic"}</CardTitle><CardDescription>Basic is free. Personal subscriptions require the payments plugin.</CardDescription></CardHeader></Card>} /></TabsContent>
    </Tabs>
    {auth?.user.isAdmin && <PluginSlot name="personal-pricing" />}
  </div>;
}
