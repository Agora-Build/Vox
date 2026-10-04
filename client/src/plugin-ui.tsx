import { lazy, Suspense, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { PluginUiProvider } from "@vox/web-plugin-sdk";

const Usage = lazy(() => import("../../plugins/credits/client/usage"));
const Grant = lazy(() => import("../../plugins/credits/client/grant"));
const Topup = lazy(() => import("../../plugins/payments/client/panels").then((m) => ({ default: m.TopupPanel })));
const Plan = lazy(() => import("../../plugins/payments/client/panels").then((m) => ({ default: m.PlanPanel })));
const Pricing = lazy(() => import("../../plugins/payments/client/pricing"));
const Notifications = lazy(() => import("../../plugins/notifications/client/page"));

export function usePluginAvailability() {
  const query = useQuery<Array<{ id: string }>>({
    queryKey: ["/api/plugins"], staleTime: 30_000,
    queryFn: async () => {
      const res = await fetch("/api/plugins", { credentials: "include" });
      if (res.status === 404) return [];
      if (!res.ok) throw new Error("Could not load enabled plugins");
      return res.json();
    },
  });
  return { ...query, enabled: (id: string) => !!query.data?.some((p) => p.id === id) };
}

export function PluginContributions({ children }: { children: ReactNode }) {
  const { enabled } = usePluginAvailability();
  return <PluginUiProvider value={{ renderSlot(name, props) {
    let component: ReactNode = null;
    if (enabled("notifications") && name === "personal-notifications") component = <a className="inline-flex items-center rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted" href="/console/notifications">Notification channels &amp; rules</a>;
    if (enabled("credits") && name === "admin-credit-grant") component = <Grant userIds={props.userIds as number[]} names={props.names as string[]} />;
    if (enabled("credits") && enabled("payments")) {
      if (name === "personal-topup") component = <Topup />;
      if (name === "personal-plan") component = <Plan />;
      if (name === "personal-pricing") component = <Pricing />;
    }
    return component ? <Suspense fallback={<p className="text-sm text-muted-foreground">Loading...</p>}>{component}</Suspense> : null;
  } }}>{children}</PluginUiProvider>;
}

export function PersonalUsagePage() {
  const { enabled, isLoading, isError } = usePluginAvailability();
  if (isLoading) return <p>Loading Usage...</p>;
  if (isError) return <p role="alert">Could not check Usage availability. Please retry.</p>;
  if (!enabled("credits")) return <p>Personal Usage is unavailable because the credits plugin is disabled.</p>;
  return <Suspense fallback={<p>Loading Usage...</p>}><Usage /></Suspense>;
}

export function PersonalNotificationsPage() {
  const { enabled, isLoading, isError } = usePluginAvailability();
  if (isLoading) return <p>Loading notification settings...</p>;
  if (isError) return <p role="alert">Could not check notification availability.</p>;
  if (!enabled("notifications")) return <p>The notifications plugin is disabled.</p>;
  return <Suspense fallback={<p>Loading notification settings...</p>}><Notifications /></Suspense>;
}
