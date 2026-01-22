import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Building2, Users, CreditCard, CheckCircle } from "lucide-react";

export default function ConsoleOrganizationCreate() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");

  const createMutation = useMutation({
    mutationFn: async (data: { name: string; address: string }) => {
      return apiRequest("POST", "/api/organizations", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/user/organization"] });
      toast({ title: "Organization created", description: "Your organization has been created successfully" });
      setLocation("/console/organization");
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create organization", description: error.message, variant: "destructive" });
    },
  });

  const handleCreate = () => {
    if (!name) {
      toast({ title: "Name required", description: "Please enter an organization name", variant: "destructive" });
      return;
    }
    createMutation.mutate({ name, address });
  };

  return (
    <div className="space-y-6 max-w-2xl mx-auto">
      <div className="text-center">
        <Building2 className="h-12 w-12 mx-auto text-primary mb-4" />
        <h1 className="text-2xl font-bold">Create an Organization</h1>
        <p className="text-muted-foreground">
          Set up a team workspace to collaborate with others
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardContent className="pt-6">
            <Users className="h-8 w-8 text-primary mb-2" />
            <h3 className="font-semibold">Team Collaboration</h3>
            <p className="text-sm text-muted-foreground">
              Invite team members and work together
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <CreditCard className="h-8 w-8 text-primary mb-2" />
            <h3 className="font-semibold">Volume Discounts</h3>
            <p className="text-sm text-muted-foreground">
              Save up to 25% with bulk seat purchases
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <CheckCircle className="h-8 w-8 text-primary mb-2" />
            <h3 className="font-semibold">Premium Features</h3>
            <p className="text-sm text-muted-foreground">
              All members get Premium access
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Organization Details</CardTitle>
          <CardDescription>
            Enter your organization's information
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Organization Name *</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter organization name"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="address">Address (Optional)</Label>
            <Textarea
              id="address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Enter organization address"
              rows={3}
            />
          </div>
          <Button
            className="w-full"
            onClick={handleCreate}
            disabled={createMutation.isPending || !name}
          >
            {createMutation.isPending ? "Creating..." : "Create Organization"}
          </Button>
        </CardContent>
      </Card>

      <Card className="bg-muted/50">
        <CardContent className="pt-6">
          <h3 className="font-semibold mb-2">What happens next?</h3>
          <ul className="text-sm text-muted-foreground space-y-1">
            <li>1. You'll become the organization admin</li>
            <li>2. Purchase seats for your team members</li>
            <li>3. Invite members using their email addresses</li>
            <li>4. Collaborate on projects and workflows</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
