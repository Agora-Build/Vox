import { Link, useLocation } from "wouter";
import { LayoutDashboard, Trophy, BookOpen, Activity, Zap, Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const navItems = [
    { href: "/", label: "Home", icon: LayoutDashboard },
    { href: "/realtime", label: "Real-time", icon: Activity },
    { href: "/leaderboard", label: "Leaderboard", icon: Trophy },
    { href: "/provider", label: "Deep Dive", icon: BookOpen },
    { href: "/test", label: "Run Test", icon: Zap },
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
          </div>

          {/* Mobile Menu Button */}
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            data-testid="button-mobile-menu"
          >
            {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </Button>
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

      <footer className="border-t border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 relative z-10">
        <div className="container mx-auto px-4 py-6">
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="flex items-center gap-2">
              <div className="bg-primary/10 p-1.5 rounded-md">
                <Activity className="h-4 w-4 text-primary" />
              </div>
              <span className="font-mono font-semibold text-sm">Vox</span>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-4 text-sm text-muted-foreground">
              <Link href="/provider" className="hover:text-foreground transition-colors">
                Deep Dive
              </Link>
              <Link href="/test" className="hover:text-foreground transition-colors">
                Run Test
              </Link>
            </div>
            <p className="text-sm text-muted-foreground">
              {new Date().getFullYear()} Vox. All rights reserved.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
