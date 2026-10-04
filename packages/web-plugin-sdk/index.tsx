import { createContext, useContext, type ReactNode } from "react";
export { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
export { Button } from "@/components/ui/button";
export { Badge } from "@/components/ui/badge";
export { Input } from "@/components/ui/input";
export { Label } from "@/components/ui/label";
export { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
export { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
export { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
export { apiRequest, queryClient } from "@/lib/queryClient";
export { useToast } from "@/hooks/use-toast";
export { ProtectedAction } from "@/components/protected-action";

export interface PluginUiContext {
  renderSlot(name: string, props: Record<string, unknown>): ReactNode;
}
const context = createContext<PluginUiContext>({ renderSlot: () => null });
export const PluginUiProvider = context.Provider;
export function PluginSlot({ name, props = {}, fallback }: { name: string; props?: Record<string, unknown>; fallback?: ReactNode }) {
  return <>{useContext(context).renderSlot(name, props) ?? fallback}</>;
}
