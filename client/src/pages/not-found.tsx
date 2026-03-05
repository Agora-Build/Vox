import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Compass, MoveRight } from "lucide-react";
import { Link } from "wouter";

export default function NotFound() {
  return (
    <div className="flex items-center justify-center px-4 py-20">
      <Card className="w-full max-w-3xl">
        <CardContent className="flex flex-col gap-6 p-10">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
                <Compass className="h-7 w-7 text-primary" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.35em] text-primary/80">404</p>
                <h1 className="text-3xl font-semibold">We couldn&apos;t find that page</h1>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              The link you followed might be broken or the page may have been moved.
            </p>
          </div>

          <p className="text-base text-muted-foreground">
            Double-check the URL, or head back to a safe spot. If you&apos;re setting up Vox for the
            first time, you can jump straight into the initialization flow.
          </p>

          <div className="flex flex-wrap gap-4 pt-2">
            <Link href="/">
              <Button className="group gap-2">
                Go home
                <MoveRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
              </Button>
            </Link>
            <Link href="/setup">
              <Button variant="outline">
                Open setup
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
