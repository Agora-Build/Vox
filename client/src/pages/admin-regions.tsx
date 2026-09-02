import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { MapPin, Pencil, Plus, Trash2, RefreshCw, Database, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useRegionLocations } from "@/hooks/use-regions";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { RegionLocation } from "@/lib/utils";

type GeoipDatabaseInfo = {
  name: "City" | "ASN";
  present: boolean;
  sizeBytes: number | null;
  modifiedAt: string | null;
};

type GeoipStatus = {
  source: "geolite2" | "dbip";
  dir: string;
  state: "idle" | "refreshing";
  databases: GeoipDatabaseInfo[];
  lastRefresh: { ok: boolean; source: string; at: string; error?: string } | null;
  attribution: string | null;
  maxmindKey: { configured: boolean; source: "console" | "env" | null };
};

function fmtBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtWhen(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "—";
}

type RegionForm = {
  baseId: string;
  displayName: string;
  city: string;
  countryCode: string;
  countryName: string;
  macroRegionCode: string;
  macroRegionName: string;
};

const EMPTY_FORM: RegionForm = {
  baseId: "",
  displayName: "",
  city: "",
  countryCode: "",
  countryName: "",
  macroRegionCode: "",
  macroRegionName: "",
};

export default function AdminRegions() {
  const { toast } = useToast();
  const { data: locations, isLoading } = useRegionLocations(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<RegionLocation | null>(null);
  const [form, setForm] = useState<RegionForm>(EMPTY_FORM);

  const { data: geoipStatus, isLoading: geoipLoading } = useQuery<GeoipStatus>({
    queryKey: ["/api/admin/geoip/status"],
    refetchInterval: (query) => (query.state.data?.state === "refreshing" ? 2000 : false),
  });
  const [maxmindKeyInput, setMaxmindKeyInput] = useState("");

  const refreshGeoipMutation = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/admin/geoip/refresh"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/geoip/status"] });
      toast({ title: "GeoIP refresh started" });
    },
    onError: (error: Error) => {
      toast({ title: "Could not start refresh", description: error.message, variant: "destructive" });
    },
  });

  const saveMaxmindKeyMutation = useMutation({
    mutationFn: async (key: string) => apiRequest("PUT", "/api/admin/geoip/maxmind-key", { key }),
    onSuccess: () => {
      setMaxmindKeyInput("");
      queryClient.invalidateQueries({ queryKey: ["/api/admin/geoip/status"] });
      toast({ title: "MaxMind key saved", description: "A GeoIP refresh has been triggered." });
    },
    onError: (error: Error) => {
      toast({ title: "Could not save MaxMind key", description: error.message, variant: "destructive" });
    },
  });

  const clearMaxmindKeyMutation = useMutation({
    mutationFn: async () => apiRequest("DELETE", "/api/admin/geoip/maxmind-key"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/geoip/status"] });
      toast({ title: "MaxMind key cleared" });
    },
    onError: (error: Error) => {
      toast({ title: "Could not clear MaxMind key", description: error.message, variant: "destructive" });
    },
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/admin/region-locations"] });
    queryClient.invalidateQueries({ queryKey: ["/api/region-locations"] });
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (editing) {
        return apiRequest("PATCH", `/api/admin/region-locations/${editing.id}`, form);
      }
      return apiRequest("POST", "/api/admin/region-locations", form);
    },
    onSuccess: () => {
      refresh();
      setDialogOpen(false);
      toast({ title: editing ? "Region updated" : "Region added" });
    },
    onError: (error: Error) => {
      toast({ title: "Could not save region", description: error.message, variant: "destructive" });
    },
  });

  const statusMutation = useMutation({
    mutationFn: async ({ location, active }: { location: RegionLocation; active: boolean }) => {
      if (!active) return apiRequest("DELETE", `/api/admin/region-locations/${location.id}`);
      return apiRequest("PATCH", `/api/admin/region-locations/${location.id}`, { isActive: true });
    },
    onSuccess: (_data, variables) => {
      refresh();
      toast({ title: variables.active ? "Region enabled" : "Region removed" });
    },
    onError: (error: Error) => {
      toast({ title: "Could not update region", description: error.message, variant: "destructive" });
    },
  });

  const mainlineMutation = useMutation({
    mutationFn: async ({ location, isMainline }: { location: RegionLocation; isMainline: boolean }) => {
      return apiRequest("PATCH", `/api/admin/region-locations/${location.id}`, { isMainline });
    },
    onSuccess: (_data, variables) => {
      refresh();
      toast({ title: variables.isMainline ? "Added to Mainline" : "Removed from Mainline" });
    },
    onError: (error: Error) => {
      toast({ title: "Could not update region", description: error.message, variant: "destructive" });
    },
  });

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (location: RegionLocation) => {
    setEditing(location);
    setForm({
      baseId: location.baseId,
      displayName: location.displayName,
      city: location.city,
      countryCode: location.countryCode,
      countryName: location.countryName,
      macroRegionCode: location.macroRegionCode,
      macroRegionName: location.macroRegionName,
    });
    setDialogOpen(true);
  };

  const updateField = (field: keyof RegionForm, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const isComplete = Object.values(form).every((value) => value.trim().length > 0);

  if (isLoading) {
    return <div className="space-y-4"><Skeleton className="h-8 w-48" /><Skeleton className="h-72 w-full" /></div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Region Locations</h1>
          <p className="text-muted-foreground">Manage cities used to allocate eval-agent site IDs.</p>
        </div>
        <Button onClick={openCreate}><Plus className="mr-2 h-4 w-4" />Add Location</Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Database className="h-4 w-4" />GeoIP databases</CardTitle>
          <CardDescription>
            City + ASN databases used for agent region detection. Downloaded from MaxMind GeoLite2 when a license
            key is configured, otherwise from DB-IP Lite.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {geoipLoading || !geoipStatus ? (
            <Skeleton className="h-32 w-full" />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <Badge variant="secondary" className="uppercase">
                  {geoipStatus.source === "geolite2" ? "GeoLite2" : "DB-IP Lite"}
                </Badge>
                {geoipStatus.state === "refreshing" && (
                  <Badge className="bg-yellow-500"><RefreshCw className="mr-1 h-3 w-3 animate-spin" />Refreshing…</Badge>
                )}
                {geoipStatus.lastRefresh && (
                  <span className="text-xs text-muted-foreground">
                    Last refresh: {geoipStatus.lastRefresh.ok ? "success" : "failed"} at {fmtWhen(geoipStatus.lastRefresh.at)}
                    {!geoipStatus.lastRefresh.ok && geoipStatus.lastRefresh.error ? ` — ${geoipStatus.lastRefresh.error}` : ""}
                  </span>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto"
                  disabled={geoipStatus.state === "refreshing" || refreshGeoipMutation.isPending}
                  onClick={() => refreshGeoipMutation.mutate()}
                >
                  <RefreshCw className="mr-2 h-4 w-4" />Refresh
                </Button>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                {geoipStatus.databases.map((db) => (
                  <div key={db.name} className="flex items-center justify-between border px-3 py-2 text-sm">
                    <span className="font-medium">{db.name}</span>
                    {db.present ? (
                      <span className="text-xs text-muted-foreground">{fmtBytes(db.sizeBytes)} · {fmtWhen(db.modifiedAt)}</span>
                    ) : (
                      <Badge variant="destructive">Missing</Badge>
                    )}
                  </div>
                ))}
              </div>

              {geoipStatus.source === "dbip" && geoipStatus.attribution && (
                <p className="text-xs text-muted-foreground">
                  {geoipStatus.attribution} —{" "}
                  <a href="https://db-ip.com" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">
                    db-ip.com<ExternalLink className="h-3 w-3" />
                  </a>
                </p>
              )}

              <div className="space-y-2 border-t pt-4">
                <Label htmlFor="maxmind-key">MaxMind license key</Label>
                {geoipStatus.maxmindKey.configured && geoipStatus.maxmindKey.source === "console" ? (
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">Configured (console)</Badge>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={clearMaxmindKeyMutation.isPending}
                      onClick={() => clearMaxmindKeyMutation.mutate()}
                    >
                      Clear
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    {geoipStatus.maxmindKey.configured && geoipStatus.maxmindKey.source === "env" && (
                      <Badge variant="secondary" className="w-fit">Configured (env)</Badge>
                    )}
                    <Input
                      id="maxmind-key"
                      type="password"
                      placeholder={
                        geoipStatus.maxmindKey.configured && geoipStatus.maxmindKey.source === "env"
                          ? "Override the env key…"
                          : "Enter a GeoLite2 license key…"
                      }
                      value={maxmindKeyInput}
                      onChange={(e) => setMaxmindKeyInput(e.target.value)}
                      className="sm:max-w-xs"
                    />
                    <Button
                      size="sm"
                      disabled={!maxmindKeyInput.trim() || saveMaxmindKeyMutation.isPending}
                      onClick={() => saveMaxmindKeyMutation.mutate(maxmindKeyInput.trim())}
                    >
                      Save
                    </Button>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  Saving a key immediately triggers a refresh and switches the source to GeoLite2. Removing it falls
                  back to the env var (if set) or DB-IP Lite.
                </p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <div className="border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Location</TableHead>
              <TableHead>Hierarchy</TableHead>
              <TableHead>Base ID</TableHead>
              <TableHead>Sites</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Mainline</TableHead>
              <TableHead>Active</TableHead>
              <TableHead className="w-[96px]">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {locations?.map((location) => (
              <TableRow key={location.id}>
                <TableCell>
                  <div className="flex items-center gap-2 font-medium"><MapPin className="h-4 w-4" />{location.displayName}</div>
                  <div className="text-xs text-muted-foreground">{location.city}, {location.countryName}</div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{location.macroRegionName}</Badge>
                  <div className="mt-1 text-xs text-muted-foreground">{location.countryCode} / {location.macroRegionCode}</div>
                </TableCell>
                <TableCell className="font-mono text-xs">{location.baseId}</TableCell>
                <TableCell>
                  <div>{location.allocatedRegions.length}</div>
                  <div className="font-mono text-xs text-muted-foreground">next {String(location.nextSequence).padStart(2, "0")}</div>
                </TableCell>
                <TableCell>
                  <Badge variant="secondary" className="capitalize">{location.source ?? "configured"}</Badge>
                </TableCell>
                <TableCell>
                  <Switch
                    checked={!!location.isMainline}
                    disabled={mainlineMutation.isPending}
                    onCheckedChange={(isMainline) => mainlineMutation.mutate({ location, isMainline })}
                  />
                </TableCell>
                <TableCell>
                  <Switch
                    checked={location.isActive}
                    disabled={statusMutation.isPending}
                    onCheckedChange={(active) => statusMutation.mutate({ location, active })}
                  />
                </TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="icon" title="Edit location" onClick={() => openEdit(location)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    {location.isActive && (
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Remove location"
                        disabled={statusMutation.isPending}
                        onClick={() => statusMutation.mutate({ location, active: false })}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {locations?.length === 0 && <div className="py-12 text-center text-muted-foreground">No region locations configured.</div>}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Location" : "Add Location"}</DialogTitle>
            <DialogDescription>
              The base ID is permanent once created because historical site IDs use it.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="region-base-id">Base ID</Label>
              <Input id="region-base-id" value={form.baseId} disabled={!!editing} placeholder="apac-in-mumbai" onChange={(e) => updateField("baseId", e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="region-display-name">Display name</Label>
              <Input id="region-display-name" value={form.displayName} placeholder="Mumbai" onChange={(e) => updateField("displayName", e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="region-city">City</Label>
              <Input id="region-city" value={form.city} placeholder="Mumbai" onChange={(e) => updateField("city", e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="region-country-code">Country code</Label>
              <Input id="region-country-code" value={form.countryCode} disabled={!!editing} maxLength={2} placeholder="IN" onChange={(e) => updateField("countryCode", e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="region-country-name">Country name</Label>
              <Input id="region-country-name" value={form.countryName} disabled={!!editing} placeholder="India" onChange={(e) => updateField("countryName", e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="region-macro-code">Macro-region code</Label>
              <Input id="region-macro-code" value={form.macroRegionCode} disabled={!!editing} placeholder="apac" onChange={(e) => updateField("macroRegionCode", e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="region-macro-name">Macro-region name</Label>
              <Input id="region-macro-name" value={form.macroRegionName} disabled={!!editing} placeholder="Asia Pacific" onChange={(e) => updateField("macroRegionName", e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button disabled={!isComplete || saveMutation.isPending} onClick={() => saveMutation.mutate()}>
              {editing ? "Save Changes" : "Add Location"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
