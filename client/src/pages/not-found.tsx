import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Compass, MoveRight } from "lucide-react";
import { Link } from "wouter";

export default function NotFound() {
  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-slate-950 text-white">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(99,102,241,0.3),_transparent_65%)]" />
      <div className="pointer-events-none absolute -top-32 -right-16 h-64 w-64 rounded-full bg-gradient-to-r from-teal-400/30 to-cyan-500/30 blur-3xl animate-[spin_18s_linear_infinite]" />
      <div className="pointer-events-none absolute -bottom-20 -left-10 h-72 w-72 rounded-full bg-gradient-to-r from-indigo-500/30 to-purple-600/30 blur-3xl animate-[spin_26s_linear_infinite]" />

      <div className="relative z-10 flex min-h-screen items-center justify-center px-4 py-16">
        <Card className="w-full max-w-3xl border border-white/10 bg-slate-900/70 shadow-2xl shadow-slate-900/40 backdrop-blur-xl">
          <CardContent className="flex flex-col gap-6 p-10">
            <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-4">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-cyan-400 to-indigo-500 text-slate-900 shadow-lg shadow-cyan-500/30 animate-bounce">
                  <Compass className="h-7 w-7" />
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.35em] text-cyan-300/80">404</p>
                  <h1 className="text-3xl font-semibold text-white">We couldn&apos;t find that page</h1>
                </div>
              </div>
              <p className="text-sm text-slate-300">
                The link you followed might be broken or the page may have been moved.
              </p>
            </div>

            <p className="text-base text-slate-300">
              Double-check the URL, or head back to a safe spot. If you&apos;re setting up Vox for the
              first time, you can jump straight into the initialization flow.
            </p>

            <div className="flex flex-wrap gap-4 pt-2">
              <Link href="/">
                <Button className="group bg-white text-slate-900 hover:bg-slate-100">
                  Go home
                  <MoveRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-1" />
                </Button>
              </Link>
              <Link href="/setup">
                <Button variant="outline" className="border-white/30 bg-transparent text-white hover:bg-white/10">
                  Open setup
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
