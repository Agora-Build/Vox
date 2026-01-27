import { useState } from "react";
import { loadStripe } from "@stripe/stripe-js";
import {
  Elements,
  CardElement,
  useStripe,
  useElements,
} from "@stripe/react-stripe-js";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Loader2 } from "lucide-react";

interface StripeCardFormProps {
  organizationId: number;
  clientSecret: string;
  stripeCustomerId: string;
  onSuccess: () => void;
  onCancel: () => void;
}

function CardForm({
  organizationId,
  clientSecret,
  stripeCustomerId,
  onSuccess,
  onCancel,
}: StripeCardFormProps) {
  const stripe = useStripe();
  const elements = useElements();
  const { toast } = useToast();
  const [isProcessing, setIsProcessing] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!stripe || !elements) {
      return;
    }

    setIsProcessing(true);

    try {
      const cardElement = elements.getElement(CardElement);
      if (!cardElement) {
        throw new Error("Card element not found");
      }

      // Confirm the setup intent
      const { error, setupIntent } = await stripe.confirmCardSetup(clientSecret, {
        payment_method: {
          card: cardElement,
        },
      });

      if (error) {
        throw new Error(error.message);
      }

      if (!setupIntent?.payment_method) {
        throw new Error("Failed to create payment method");
      }

      // Save the payment method to our backend
      await apiRequest("POST", `/api/organizations/${organizationId}/payments/methods`, {
        stripePaymentMethodId: setupIntent.payment_method,
        stripeCustomerId,
      });

      queryClient.invalidateQueries({
        queryKey: ["/api/organizations", organizationId, "payments", "methods"],
      });

      toast({ title: "Payment method added successfully" });
      onSuccess();
    } catch (error) {
      toast({
        title: "Failed to add payment method",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="p-4 border rounded-lg bg-background">
        <CardElement
          options={{
            style: {
              base: {
                fontSize: "16px",
                color: "hsl(var(--foreground))",
                "::placeholder": {
                  color: "hsl(var(--muted-foreground))",
                },
              },
              invalid: {
                color: "hsl(var(--destructive))",
              },
            },
          }}
        />
      </div>
      <div className="flex gap-2 justify-end">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!stripe || isProcessing}>
          {isProcessing ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Processing...
            </>
          ) : (
            "Add Card"
          )}
        </Button>
      </div>
    </form>
  );
}

interface StripeCardFormWrapperProps {
  publishableKey: string;
  organizationId: number;
  clientSecret: string;
  stripeCustomerId: string;
  onSuccess: () => void;
  onCancel: () => void;
}

export function StripeCardForm({
  publishableKey,
  organizationId,
  clientSecret,
  stripeCustomerId,
  onSuccess,
  onCancel,
}: StripeCardFormWrapperProps) {
  const stripePromise = loadStripe(publishableKey);

  return (
    <Elements stripe={stripePromise}>
      <CardForm
        organizationId={organizationId}
        clientSecret={clientSecret}
        stripeCustomerId={stripeCustomerId}
        onSuccess={onSuccess}
        onCancel={onCancel}
      />
    </Elements>
  );
}
