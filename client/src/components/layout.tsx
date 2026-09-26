import { Link, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { LayoutDashboard, Trophy, BookOpen, Activity, Rocket, Swords, Menu, X, Github, Mail, LogIn, LogOut, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ThemeToggle } from "@/components/theme-toggle";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient, getQueryFn } from "@/lib/queryClient";

interface AuthStatus {
  initialized: boolean;
  user: {
    id: string;
    username: string;
    email: string;
    plan: string;
    isAdmin: boolean;
  } | null;
}

/**
 * X (formerly Twitter) brand mark. lucide ships no brand logos — its `X` is the
 * close/cross glyph, which in a row of social icons reads as a dismiss button.
 */
function XLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
    </svg>
  );
}

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { toast } = useToast();

  const { data: authStatus } = useQuery<AuthStatus | null>({
    queryKey: ["/api/auth/status"],
    queryFn: getQueryFn({ on401: "returnNull" }),
  });

  // Public config: the GeoIP credit (when DB-IP Lite's CC-BY-4.0 requires it)
  // and the deployment's contact links. Each link is rendered ONLY when the
  // server sends it, so an unconfigured deployment shows no icon rather than
  // one that goes nowhere.
  const { data: publicConfig } = useQuery<{
    geoipAttribution?: string;
    contactEmail?: string;
    githubUrl?: string;
    xUrl?: string;
  }>({
    queryKey: ["/api/config"],
    staleTime: 60 * 60 * 1000,
  });

  const logoutMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/auth/logout");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/status"] });
      setLocation("/");
    },
    onError: (error: Error) => {
      toast({ title: "Logout failed", description: error.message, variant: "destructive" });
    },
  });

  const user = authStatus?.user ?? null;

  const navItems = [
    { href: "/", label: "Home", icon: LayoutDashboard },
    { href: "/realtime", label: "Real-time", icon: Activity },
    { href: "/leaderboard", label: "Leaderboard", icon: Trophy },
    { href: "/dive", label: "Deep Dive", icon: BookOpen },
    { href: "/run-your-own", label: "Run Your Own", icon: Rocket },
    { href: "/clash", label: "Clash", icon: Swords },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground font-sans selection:bg-primary/20 relative flex flex-col">
      {/* Global Grid Pattern */}
      <div className="absolute inset-0 bg-grid-pattern opacity-[0.15] pointer-events-none fixed" />
      
      <nav className="border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 sticky top-0 z-50">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="bg-primary/10 p-2 rounded-lg">
              <Activity className="h-6 w-6 text-primary" />
            </div>
            <span className="font-mono font-bold text-lg tracking-tight">Vox</span>
          </div>

          {/* Desktop Navigation */}
          <div className="hidden md:flex items-center gap-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = location === item.href;
              return (
                <Link key={item.href} href={item.href}>
                  <div
                    className={cn(
                      "flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors cursor-pointer",
                      isActive
                        ? "bg-secondary text-primary"
                        : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    <span className="hidden lg:inline">{item.label}</span>
                  </div>
                </Link>
              );
            })}
            <ThemeToggle />
            {user ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="rounded-full" data-testid="button-user-menu">
                    <Avatar className="h-8 w-8">
                      <AvatarFallback>{user.username[0].toUpperCase()}</AvatarFallback>
                    </Avatar>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>{user.username}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setLocation("/console")}>
                    <User className="mr-2 h-4 w-4" />
                    Console
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => logoutMutation.mutate()} disabled={logoutMutation.isPending}>
                    <LogOut className="mr-2 h-4 w-4" />
                    Sign Out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Link href="/login">
                <Button variant="ghost" size="icon" data-testid="button-sign-in">
                  <LogIn className="h-4 w-4" />
                </Button>
              </Link>
            )}
          </div>

          {/* Mobile Menu Button */}
          <div className="flex items-center gap-1 md:hidden">
            <ThemeToggle />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              data-testid="button-mobile-menu"
            >
              {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </Button>
          </div>
        </div>

        {/* Mobile Navigation Menu */}
        <div
          className={cn(
            "md:hidden border-t border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 overflow-hidden transition-all duration-300",
            mobileMenuOpen ? "max-h-96" : "max-h-0"
          )}
        >
          <div className="container mx-auto px-4 py-2 space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = location === item.href;
              return (
                <Link key={item.href} href={item.href}>
                  <div
                    onClick={() => setMobileMenuOpen(false)}
                    className={cn(
                      "flex items-center gap-3 px-4 py-3 rounded-md text-sm font-medium transition-colors cursor-pointer",
                      isActive
                        ? "bg-secondary text-primary"
                        : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                    )}
                  >
                    <Icon className="h-5 w-5" />
                    <span>{item.label}</span>
                  </div>
                </Link>
              );
            })}
            <div className="border-t border-border/40 pt-1 mt-1">
              {user ? (
                <>
                  <Link href="/console">
                    <div
                      onClick={() => setMobileMenuOpen(false)}
                      className="flex items-center gap-3 px-4 py-3 rounded-md text-sm font-medium transition-colors cursor-pointer text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                    >
                      <User className="h-5 w-5" />
                      <span>Console</span>
                    </div>
                  </Link>
                  <div
                    onClick={() => { setMobileMenuOpen(false); logoutMutation.mutate(); }}
                    className="flex items-center gap-3 px-4 py-3 rounded-md text-sm font-medium transition-colors cursor-pointer text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                  >
                    <LogOut className="h-5 w-5" />
                    <span>Sign Out</span>
                  </div>
                </>
              ) : (
                <Link href="/login">
                  <div
                    onClick={() => setMobileMenuOpen(false)}
                    className="flex items-center gap-3 px-4 py-3 rounded-md text-sm font-medium transition-colors cursor-pointer text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                  >
                    <LogIn className="h-5 w-5" />
                    <span>Sign In</span>
                  </div>
                </Link>
              )}
            </div>
          </div>
        </div>
      </nav>

      <main className="container mx-auto px-4 py-6 md:py-8 relative z-10 flex-1">
        {children}
      </main>

      <footer className="border-t border-border/40 bg-secondary/30 backdrop-blur supports-[backdrop-filter]:bg-secondary/20 relative z-10">
        <div className="container mx-auto px-4 py-10 md:py-12">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-8 md:gap-12">
            {/* Brand */}
            <div className="col-span-1 sm:col-span-2 md:col-span-1 space-y-4">
              <div className="flex items-center gap-2">
                <div className="bg-primary/10 p-2 rounded-lg">
                  <Activity className="h-5 w-5 text-primary" />
                </div>
                <span className="font-mono font-bold text-lg">Vox</span>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Track and evaluate conversational AI performance across multiple regions worldwide.
              </p>
            </div>

            {/* Products — the source of truth for what Vox ships; providers we test are a different list */}
            <div className="space-y-4">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Products</h4>
              <ul className="space-y-3">
                <li>
                  <Link href="/realtime" className="text-sm hover:text-foreground transition-colors text-muted-foreground" data-testid="link-footer-realtime">
                    Real-time Eval
                  </Link>
                </li>
                <li>
                  <Link href="/leaderboard" className="text-sm hover:text-foreground transition-colors text-muted-foreground" data-testid="link-footer-leaderboard">
                    Leaderboard
                  </Link>
                </li>
                <li>
                  <a href="https://github.com/Agora-Build/aeval" target="_blank" rel="noreferrer" className="text-sm hover:text-foreground transition-colors text-muted-foreground" data-testid="link-footer-aeval">
                    aeval
                  </a>
                </li>
                <li>
                  <a href="https://github.com/Agora-Build/DialF" target="_blank" rel="noreferrer" className="text-sm hover:text-foreground transition-colors text-muted-foreground" data-testid="link-footer-dialf">
                    DialF
                  </a>
                </li>
                <li>
                  <Link href="/run-your-own" className="text-sm hover:text-foreground transition-colors text-muted-foreground" data-testid="link-footer-test">
                    Run Your Own
                  </Link>
                </li>
              </ul>
            </div>

            {/* Resources */}
            <div className="space-y-4">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Resources</h4>
              <ul className="space-y-3">
                <li>
                  <Link href="/dive" className="text-sm hover:text-foreground transition-colors text-muted-foreground" data-testid="link-footer-deepdive">
                    Deep Dive
                  </Link>
                </li>
                <li>
                  <Link href="/api-docs" className="text-sm hover:text-foreground transition-colors text-muted-foreground" data-testid="link-footer-api-docs">
                    API Docs
                  </Link>
                </li>
              </ul>
            </div>

            {/* Connect */}
            <div className="space-y-4">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Connect</h4>
              <div className="flex items-center gap-3">
                {publicConfig?.githubUrl && (
                  <a href={publicConfig.githubUrl} target="_blank" rel="noopener noreferrer">
                    <Button variant="ghost" size="icon" className="h-8 w-8" data-testid="button-footer-github">
                      <Github className="h-4 w-4" />
                    </Button>
                  </a>
                )}
                {publicConfig?.xUrl && (
                  <a href={publicConfig.xUrl} target="_blank" rel="noopener noreferrer" aria-label="X">
                    <Button variant="ghost" size="icon" className="h-8 w-8" data-testid="button-footer-x">
                      <XLogo className="h-4 w-4" />
                    </Button>
                  </a>
                )}
                {publicConfig?.contactEmail && (
                  <a href={`mailto:${publicConfig.contactEmail}`}>
                    <Button variant="ghost" size="icon" className="h-8 w-8" data-testid="button-footer-email">
                      <Mail className="h-4 w-4" />
                    </Button>
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Bar */}
        <div className="border-t border-border/40">
          <div className="container mx-auto px-4 py-4">
            <div className="flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-muted-foreground">
              <p>{new Date().getFullYear()} Vox. All rights reserved.</p>
              <div className="flex items-center gap-4">
                <Link href="/privacy" className="hover:text-foreground transition-colors" data-testid="link-footer-privacy">Privacy</Link>
                <Link href="/terms" className="hover:text-foreground transition-colors" data-testid="link-footer-terms">Terms</Link>
              </div>
            </div>
            {/* CC-BY-4.0 credit — present only when the server loaded DB-IP data */}
            {publicConfig?.geoipAttribution && (
              <p className="mt-2 text-center sm:text-left text-[11px] text-muted-foreground/70" data-testid="text-geoip-attribution">
                This product includes IP geolocation data created by{" "}
                <a href="https://db-ip.com" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground transition-colors">DB-IP</a>,
                {" "}available from https://db-ip.com
              </p>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}
