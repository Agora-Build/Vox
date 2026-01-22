import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { CreditCard, Plus, Trash2, Check } from "lucide-react";

interface AuthStatus {
  user: {
    organizationId: number | null;
    isOrgAdmin: boolean;
  } | null;
}

interface SeatInfo {
  totalSeats: number;
  usedSeats: number;
  availableSeats: number;
  pricePerSeat: number;
  discountPercent: number;
}

interface PriceCalculation {
  totalSeats: number;
  pricePerSeat: number;
  discountPercent: number;
  subtotal: number;
  discount: number;
  total: number;
}

interface PaymentMethod {
  id: number;
  lastFour: string;
  expiryMonth: number;
  expiryYear: number;
  isDefault: boolean;
  createdAt: string;
}

interface PaymentHistory {
  id: number;
  amount: number;
  status: string;
  description: string;
  createdAt: string;
}

interface PricingTier {
  name: string;
  pricePerSeat: number;
  minSeats: number;
  maxSeats: number;
  discountPercent: number;
}

export default function ConsoleOrganizationBilling() {
  const { toast } = useToast();
  const [additionalSeats, setAdditionalSeats] = useState(1);
  const [purchaseDialogOpen, setPurchaseDialogOpen] = useState(false);

  const { data: authStatus } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });

  const orgId = authStatus?.user?.organizationId;

  const { data: seats, isLoading: seatsLoading } = useQuery<SeatInfo>({
    queryKey: ["/api/organizations", orgId, "seats"],
    queryFn: async () => {
      const response = await fetch(`/api/organizations/${orgId}/seats`);
      if (!response.ok) throw new Error("Failed to fetch seats");
      return response.json();
    },
    enabled: !!orgId,
  });

  const { data: pricing } = useQuery<PricingTier[]>({
    queryKey: ["/api/pricing"],
  });

  const { data: paymentMethods, isLoading: methodsLoading } = useQuery<PaymentMethod[]>({
    queryKey: ["/api/organizations", orgId, "payments", "methods"],
    queryFn: async () => {
      const response = await fetch(`/api/organizations/${orgId}/payments/methods`);
      if (!response.ok) throw new Error("Failed to fetch payment methods");
      return response.json();
    },
    enabled: !!orgId,
  });

  const { data: paymentHistory, isLoading: historyLoading } = useQuery<PaymentHistory[]>({
    queryKey: ["/api/organizations", orgId, "payments", "history"],
    queryFn: async () => {
      const response = await fetch(`/api/organizations/${orgId}/payments/history`);
      if (!response.ok) throw new Error("Failed to fetch payment history");
      return response.json();
    },
    enabled: !!orgId,
  });

  const { data: stripeStatus } = useQuery<{ enabled: boolean }>({
    queryKey: ["/api/payments/stripe-status"],
  });

  const calculateMutation = useMutation({
    mutationFn: async (seats: number): Promise<PriceCalculation> => {
      const res = await apiRequest("POST", `/api/organizations/${orgId}/seats/calculate`, { additionalSeats: seats });
      return res.json();
    },
  });

  const purchaseMutation = useMutation({
    mutationFn: async ({ seats, paymentMethodId }: { seats: number; paymentMethodId?: number }) => {
      return apiRequest("POST", `/api/organizations/${orgId}/seats/purchase`, {
        additionalSeats: seats,
        paymentMethodId,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/organizations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/user/organization"] });
      setPurchaseDialogOpen(false);
      setAdditionalSeats(1);
      toast({ title: "Purchase successful", description: "Seats added to your organization" });
    },
    onError: (error: Error) => {
      toast({ title: "Purchase failed", description: error.message, variant: "destructive" });
    },
  });

  const deletePaymentMethodMutation = useMutation({
    mutationFn: async (methodId: number) => {
      return apiRequest("DELETE", `/api/organizations/${orgId}/payments/methods/${methodId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/organizations", orgId, "payments", "methods"] });
      toast({ title: "Payment method deleted" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to delete", description: error.message, variant: "destructive" });
    },
  });

  const handleCalculate = () => {
    if (additionalSeats > 0) {
      calculateMutation.mutate(additionalSeats);
    }
  };

  const handlePurchase = () => {
    const defaultMethod = paymentMethods?.find(m => m.isDefault);
    purchaseMutation.mutate({
      seats: additionalSeats,
      paymentMethodId: defaultMethod?.id,
    });
  };

  const formatCurrency = (cents: number) => {
    return `$${(cents / 100).toFixed(2)}`;
  };

  if (seatsLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Billing & Seats</h1>
        <p className="text-muted-foreground">Manage your organization's seats and billing</p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Current Seats */}
        <Card>
          <CardHeader>
            <CardTitle>Current Seats</CardTitle>
            <CardDescription>Your organization's seat allocation</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex justify-between items-center">
              <span>Total Seats</span>
              <span className="font-bold">{seats?.totalSeats || 0}</span>
            </div>
            <div className="flex justify-between items-center">
              <span>Used Seats</span>
              <span className="font-bold">{seats?.usedSeats || 0}</span>
            </div>
            <div className="flex justify-between items-center">
              <span>Available Seats</span>
              <span className="font-bold text-green-600">{seats?.availableSeats || 0}</span>
            </div>
            {seats?.discountPercent && seats.discountPercent > 0 ? (
              <Badge variant="secondary">
                {seats.discountPercent}% volume discount applied
              </Badge>
            ) : null}
          </CardContent>
        </Card>

        {/* Purchase Seats */}
        <Card>
          <CardHeader>
            <CardTitle>Purchase Seats</CardTitle>
            <CardDescription>Add more seats to your organization</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Input
                type="number"
                min={1}
                value={additionalSeats}
                onChange={(e) => setAdditionalSeats(parseInt(e.target.value) || 1)}
                className="w-24"
              />
              <Button variant="outline" onClick={handleCalculate} disabled={calculateMutation.isPending}>
                Calculate
              </Button>
            </div>

            {calculateMutation.data && (
              <div className="space-y-2 p-4 bg-muted rounded-lg">
                <div className="flex justify-between">
                  <span>Subtotal ({additionalSeats} seats)</span>
                  <span>{formatCurrency(calculateMutation.data.subtotal)}</span>
                </div>
                {calculateMutation.data.discount > 0 && (
                  <div className="flex justify-between text-green-600">
                    <span>Discount ({calculateMutation.data.discountPercent}%)</span>
                    <span>-{formatCurrency(calculateMutation.data.discount)}</span>
                  </div>
                )}
                <div className="flex justify-between font-bold border-t pt-2">
                  <span>Total</span>
                  <span>{formatCurrency(calculateMutation.data.total)}</span>
                </div>
              </div>
            )}

            <Dialog open={purchaseDialogOpen} onOpenChange={setPurchaseDialogOpen}>
              <DialogTrigger asChild>
                <Button
                  className="w-full"
                  disabled={!calculateMutation.data}
                  onClick={() => setPurchaseDialogOpen(true)}
                >
                  Purchase {additionalSeats} Seat{additionalSeats > 1 ? "s" : ""}
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Confirm Purchase</DialogTitle>
                  <DialogDescription>
                    You are about to purchase {additionalSeats} seat{additionalSeats > 1 ? "s" : ""} for{" "}
                    {calculateMutation.data && formatCurrency(calculateMutation.data.total)}.
                  </DialogDescription>
                </DialogHeader>
                {!stripeStatus?.enabled && (
                  <p className="text-sm text-yellow-600">
                    Stripe is not configured. This will be a test purchase.
                  </p>
                )}
                <DialogFooter>
                  <Button variant="outline" onClick={() => setPurchaseDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button onClick={handlePurchase} disabled={purchaseMutation.isPending}>
                    {purchaseMutation.isPending ? "Processing..." : "Confirm Purchase"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </CardContent>
        </Card>
      </div>

      {/* Pricing Tiers */}
      {pricing && pricing.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Pricing Tiers</CardTitle>
            <CardDescription>Volume discounts based on total seats</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tier</TableHead>
                  <TableHead>Seats</TableHead>
                  <TableHead>Price/Seat</TableHead>
                  <TableHead>Discount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pricing.map((tier) => (
                  <TableRow key={tier.name}>
                    <TableCell className="font-medium">{tier.name}</TableCell>
                    <TableCell>
                      {tier.minSeats === tier.maxSeats
                        ? tier.minSeats
                        : tier.maxSeats === 9999
                          ? `${tier.minSeats}+`
                          : `${tier.minSeats}-${tier.maxSeats}`}
                    </TableCell>
                    <TableCell>{formatCurrency(tier.pricePerSeat)}/month</TableCell>
                    <TableCell>
                      {tier.discountPercent > 0 ? (
                        <Badge variant="secondary">{tier.discountPercent}% off</Badge>
                      ) : (
                        "-"
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Payment Methods */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CreditCard className="h-5 w-5" />
            Payment Methods
          </CardTitle>
          <CardDescription>Manage your payment methods</CardDescription>
        </CardHeader>
        <CardContent>
          {methodsLoading ? (
            <Skeleton className="h-24" />
          ) : paymentMethods && paymentMethods.length > 0 ? (
            <div className="space-y-2">
              {paymentMethods.map((method) => (
                <div
                  key={method.id}
                  className="flex items-center justify-between p-3 border rounded-lg"
                >
                  <div className="flex items-center gap-3">
                    <CreditCard className="h-5 w-5" />
                    <div>
                      <p className="font-medium">**** **** **** {method.lastFour}</p>
                      <p className="text-sm text-muted-foreground">
                        Expires {method.expiryMonth}/{method.expiryYear}
                      </p>
                    </div>
                    {method.isDefault && (
                      <Badge variant="secondary" className="gap-1">
                        <Check className="h-3 w-3" />
                        Default
                      </Badge>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => deletePaymentMethodMutation.mutate(method.id)}
                    disabled={deletePaymentMethodMutation.isPending}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8">
              <p className="text-muted-foreground mb-4">No payment methods added</p>
              {stripeStatus?.enabled ? (
                <Button>
                  <Plus className="mr-2 h-4 w-4" />
                  Add Payment Method
                </Button>
              ) : (
                <p className="text-sm text-yellow-600">
                  Stripe is not configured. Payment methods are disabled.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Payment History */}
      <Card>
        <CardHeader>
          <CardTitle>Payment History</CardTitle>
          <CardDescription>Your organization's payment history</CardDescription>
        </CardHeader>
        <CardContent>
          {historyLoading ? (
            <Skeleton className="h-24" />
          ) : paymentHistory && paymentHistory.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paymentHistory.map((payment) => (
                  <TableRow key={payment.id}>
                    <TableCell>{new Date(payment.createdAt).toLocaleDateString()}</TableCell>
                    <TableCell>{payment.description}</TableCell>
                    <TableCell>{formatCurrency(payment.amount)}</TableCell>
                    <TableCell>
                      <Badge
                        variant={payment.status === "completed" ? "default" : "secondary"}
                      >
                        {payment.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-center py-8 text-muted-foreground">No payment history</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
