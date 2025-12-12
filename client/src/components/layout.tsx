import { Link, useLocation } from "wouter";
import { LayoutDashboard, Trophy, BookOpen, Activity, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  const navItems = [
    { href: "/", label: "Home", icon: LayoutDashboard },
    { href: "/realtime", label: "Real-time", icon: Activity },
    { href: "/leaderboard", label: "Leaderboard", icon: Trophy },
    { href: "/provider", label: "Provider Guide", icon: BookOpen },
    { href: "/test", label: "Run Test", icon: Zap },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground font-sans selection:bg-primary/20 relative">
       {/* Global Grid Pattern */}
      <div className="absolute inset-0 bg-grid-pattern opacity-[0.15] pointer-events-none fixed" />
      
      <nav className="border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 sticky top-0 z-50">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="bg-primary/10 p-2 rounded-lg">
              <Activity className="h-6 w-6 text-primary" />
            </div>
            <span className="font-mono font-bold text-lg tracking-tight">Vox</span>
          </div>

          <div className="flex items-center gap-1">
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
                    {item.label}
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      </nav>

      <main className="container mx-auto px-4 py-8 relative z-10">
        {children}
      </main>
    </div>
  );
}
