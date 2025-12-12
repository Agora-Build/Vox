import { Link, useLocation } from "wouter";
import { LayoutDashboard, Trophy, BookOpen, Activity, Zap, Menu, X, Github, Twitter, Mail } from "lucide-react";
import { cn } from "@/lib/utils";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const navItems = [
    { href: "/", label: "Home", icon: LayoutDashboard },
    { href: "/realtime", label: "Real-time", icon: Activity },
    { href: "/leaderboard", label: "Leaderboard", icon: Trophy },
    { href: "/dive", label: "Deep Dive", icon: BookOpen },
    { href: "/run-your-own", label: "Run Test", icon: Zap },
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
            mobileMenuOpen ? "max-h-80" : "max-h-0"
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
                Track and benchmark conversational AI performance across multiple regions worldwide.
              </p>
            </div>

            {/* Product */}
            <div className="space-y-4">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Product</h4>
              <ul className="space-y-3">
                <li>
                  <Link href="/realtime" className="text-sm hover:text-foreground transition-colors text-muted-foreground" data-testid="link-footer-realtime">
                    Real-time
                  </Link>
                </li>
                <li>
                  <Link href="/leaderboard" className="text-sm hover:text-foreground transition-colors text-muted-foreground" data-testid="link-footer-leaderboard">
                    Leaderboard
                  </Link>
                </li>
                <li>
                  <Link href="/run-your-own" className="text-sm hover:text-foreground transition-colors text-muted-foreground" data-testid="link-footer-test">
                    Run Test
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
                  <span className="text-sm text-muted-foreground/60 cursor-default">
                    API Docs
                  </span>
                </li>
                <li>
                  <span className="text-sm text-muted-foreground/60 cursor-default">
                    Changelog
                  </span>
                </li>
              </ul>
            </div>

            {/* Connect */}
            <div className="space-y-4">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Connect</h4>
              <div className="flex items-center gap-3">
                <a href="https://github.com" target="_blank" rel="noopener noreferrer">
                  <Button variant="ghost" size="icon" className="h-8 w-8" data-testid="button-footer-github">
                    <Github className="h-4 w-4" />
                  </Button>
                </a>
                <a href="https://twitter.com" target="_blank" rel="noopener noreferrer">
                  <Button variant="ghost" size="icon" className="h-8 w-8" data-testid="button-footer-twitter">
                    <Twitter className="h-4 w-4" />
                  </Button>
                </a>
                <a href="mailto:contact@vox.ai">
                  <Button variant="ghost" size="icon" className="h-8 w-8" data-testid="button-footer-email">
                    <Mail className="h-4 w-4" />
                  </Button>
                </a>
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
          </div>
        </div>
      </footer>
    </div>
  );
}
