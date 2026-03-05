import { useEffect, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, AlertCircle } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useQueryClient } from "@tanstack/react-query";

export default function AuthGithubCallback() {
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(searchString);
    const code = params.get("code");
    const state = params.get("state");

    if (!code || !state) {
      setError("Missing authorization parameters from GitHub.");
      return;
    }

    let cancelled = false;

    async function exchange() {
      try {
        const res = await apiRequest("POST", "/api/auth/github/callback", { code, state });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "GitHub authentication failed");
        }
        if (cancelled) return;
        await queryClient.invalidateQueries({ queryKey: ["/api/auth/status"] });
        setLocation("/console");
      } catch (err: any) {
        if (cancelled) return;
        setError(err.message || "GitHub authentication failed");
      }
    }

    exchange();
    return () => { cancelled = true; };
  }, [searchString, setLocation, queryClient]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <AlertCircle className="mx-auto h-10 w-10 text-destructive mb-2" />
            <CardTitle className="text-xl">Sign In Failed</CardTitle>
          </CardHeader>
          <CardContent className="text-center space-y-4">
            <p className="text-sm text-muted-foreground">{error}</p>
            <a href="/login" className="text-sm text-primary hover:underline">
              Back to Sign In
            </a>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-xl">Signing you in</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Completing GitHub authentication...</p>
        </CardContent>
      </Card>
    </div>
  );
}
