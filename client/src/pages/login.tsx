import { useState, useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Loader2 } from "lucide-react";

interface LoginResponse {
  user: {
    id: string;
    username: string;
    email: string;
    isAdmin: boolean;
  };
}

type LoginVariant = "user" | "admin";

interface LoginFormProps {
  variant?: LoginVariant;
}

export function LoginForm({ variant = "user" }: LoginFormProps) {
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const isAdminVariant = variant === "admin";

  // Check if Google OAuth is available
  const { data: googleStatus } = useQuery<{ enabled: boolean }>({
    queryKey: ["/api/auth/google/status"],
  });

  // Handle OAuth error from redirect
  useEffect(() => {
    const params = new URLSearchParams(searchString);
    if (params.get("error") === "oauth_failed") {
      toast({
        title: "Google Sign In Failed",
        description: "Unable to sign in with Google. Please try again or use email.",
        variant: "destructive",
      });
    }
  }, [searchString, toast]);

  const loginMutation = useMutation<LoginResponse>({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/auth/login", { email, password });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/status"] });

      if (isAdminVariant && !data.user?.isAdmin) {
        toast({ title: "Admin access required", description: "Please sign in with an admin account.", variant: "destructive" });
        return;
      }

      const isAdmin = data.user?.isAdmin;
      const destination = isAdmin ? "/admin/console" : "/console";
      toast({ title: isAdmin ? "Welcome back, Admin!" : "Welcome back!" });
      setLocation(destination);
    },
    onError: (error: Error) => {
      toast({ title: "Login failed", description: error.message, variant: "destructive" });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    loginMutation.mutate();
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl" data-testid="text-login-title">
            {isAdminVariant ? "Admin Sign In" : "Sign In"}
          </CardTitle>
          <CardDescription>
            {isAdminVariant ? "Access the Vox admin console" : "Sign in to your Vox workspace"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder={isAdminVariant ? "admin@example.com" : "you@example.com"}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                data-testid="input-email"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                data-testid="input-password"
              />
            </div>
            <Button
              type="submit"
              className="w-full"
              disabled={loginMutation.isPending}
              data-testid="button-login"
            >
              {loginMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Signing in...
                </>
              ) : (
                "Sign In"
              )}
            </Button>
          </form>

          {/* Google OAuth - only show for regular users, not admin login */}
          {!isAdminVariant && googleStatus?.enabled && (
            <>
              <div className="relative my-4">
                <Separator />
                <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-2 text-xs text-muted-foreground">
                  or
                </span>
              </div>
              <Button
                variant="outline"
                className="w-full"
                onClick={() => window.location.href = "/api/auth/google"}
                data-testid="button-google-login"
              >
                <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24">
                  <path
                    fill="currentColor"
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  />
                  <path
                    fill="currentColor"
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  />
                  <path
                    fill="currentColor"
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                  />
                  <path
                    fill="currentColor"
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                  />
                </svg>
                Continue with Google
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function Login() {
  return <LoginForm variant="user" />;
}

