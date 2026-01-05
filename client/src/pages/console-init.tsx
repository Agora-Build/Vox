import { useState } from "react";
import { useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Loader2, Shield, Sparkles } from "lucide-react";

export default function ConsoleInit() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const [code, setCode] = useState("");
  const [adminUsername, setAdminUsername] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const initMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/auth/init", {
        code,
        adminUsername,
        adminEmail,
        adminPassword,
      });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/status"] });
      toast({ 
        title: "System initialized!", 
        description: `Welcome, ${data.admin.username}! Scout has been created as your platform agent.` 
      });
      setLocation("/console");
    },
    onError: (error: Error) => {
      toast({ title: "Initialization failed", description: error.message, variant: "destructive" });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (adminPassword !== confirmPassword) {
      toast({ title: "Passwords don't match", variant: "destructive" });
      return;
    }
    
    if (adminPassword.length < 8) {
      toast({ title: "Password must be at least 8 characters", variant: "destructive" });
      return;
    }
    
    initMutation.mutate();
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-lg">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <Shield className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-2xl" data-testid="text-init-title">Initialize Vox</CardTitle>
          <CardDescription>
            Set up your admin account to get started. This can only be done once.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="code">Initialization Code</Label>
              <Input
                id="code"
                type="text"
                placeholder="Enter initialization code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                data-testid="input-init-code"
              />
              <p className="text-xs text-muted-foreground">
                For development: VOX-DEBUG-2024
              </p>
            </div>
            
            <div className="border-t pt-4 mt-4">
              <h3 className="font-medium mb-3 flex items-center gap-2">
                Admin Account
              </h3>
              
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="username">Username</Label>
                  <Input
                    id="username"
                    type="text"
                    placeholder="admin"
                    value={adminUsername}
                    onChange={(e) => setAdminUsername(e.target.value)}
                    required
                    data-testid="input-admin-username"
                  />
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="admin@example.com"
                    value={adminEmail}
                    onChange={(e) => setAdminEmail(e.target.value)}
                    required
                    data-testid="input-admin-email"
                  />
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    value={adminPassword}
                    onChange={(e) => setAdminPassword(e.target.value)}
                    required
                    minLength={8}
                    data-testid="input-admin-password"
                  />
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="confirmPassword">Confirm Password</Label>
                  <Input
                    id="confirmPassword"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    data-testid="input-confirm-password"
                  />
                </div>
              </div>
            </div>

            <div className="bg-muted/50 rounded-lg p-3 flex items-start gap-3">
              <Sparkles className="h-5 w-5 text-primary shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-medium">Scout will be created</p>
                <p className="text-muted-foreground">
                  Scout is your platform's principal agent with full mainline curation powers.
                </p>
              </div>
            </div>
            
            <Button 
              type="submit" 
              className="w-full" 
              disabled={initMutation.isPending}
              data-testid="button-initialize"
            >
              {initMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Initializing...
                </>
              ) : (
                "Initialize System"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
