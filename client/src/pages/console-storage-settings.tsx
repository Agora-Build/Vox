import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { HardDrive, Save, Trash2, Lock } from "lucide-react";
import { useState, useEffect } from "react";

interface StorageConfig {
  id: number;
  s3Endpoint: string;
  s3Bucket: string;
  s3Region: string;
  s3AccessKeyId: string;  // masked: ****xxxx
  createdAt: string;
  updatedAt: string;
}

interface AuthStatus {
  user: { plan: string } | null;
}

export default function ConsoleStorageSettings() {
  const { toast } = useToast();
  const { data: auth } = useQuery<AuthStatus>({ queryKey: ["/api/auth/status"] });
  const isBasic = auth?.user?.plan === "basic";

  const { data: config, isLoading } = useQuery<StorageConfig | null>({
    queryKey: ["/api/user/storage-config"],
  });

  const [endpoint, setEndpoint] = useState("");
  const [bucket, setBucket] = useState("");
  const [region, setRegion] = useState("auto");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Populate form when config loads
  useEffect(() => {
    if (config) {
      setEndpoint(config.s3Endpoint);
      setBucket(config.s3Bucket);
      setRegion(config.s3Region);
      setAccessKeyId("");
      setSecretAccessKey("");
    }
  }, [config]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("PUT", "/api/user/storage-config", {
        s3Endpoint: endpoint,
        s3Bucket: bucket,
        s3Region: region,
        s3AccessKeyId: accessKeyId,
        s3SecretAccessKey: secretAccessKey,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/user/storage-config"] });
      setAccessKeyId("");
      setSecretAccessKey("");
      toast({ title: "Storage config saved" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to save storage config", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", "/api/user/storage-config");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/user/storage-config"] });
      setEndpoint("");
      setBucket("");
      setRegion("auto");
      setAccessKeyId("");
      setSecretAccessKey("");
      setDeleteOpen(false);
      toast({ title: "Storage config removed. Artifacts will use system default." });
    },
  });

  if (isBasic) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Storage Settings</h1>
          <p className="text-muted-foreground">Configure your own S3-compatible storage for eval artifacts</p>
        </div>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Lock className="h-8 w-8 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">Premium feature</h3>
            <p className="text-sm text-muted-foreground max-w-md">
              Upgrade to Premium or higher to store eval artifacts in your own S3-compatible storage (AWS S3, Cloudflare R2, MinIO).
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const hasExistingConfig = !!config;
  const canSave = endpoint.trim() && bucket.trim() && accessKeyId.trim() && secretAccessKey.trim();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Storage Settings</h1>
        <p className="text-muted-foreground">Configure your own S3-compatible storage for eval artifacts</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HardDrive className="h-5 w-5" />
            S3-Compatible Storage
          </CardTitle>
          <CardDescription>
            {hasExistingConfig
              ? "Your artifacts are stored in your own bucket. Update credentials below."
              : "Override the default storage. Your eval artifacts will be stored in your own bucket."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="s3-endpoint">Endpoint URL</Label>
                  <Input id="s3-endpoint" value={endpoint} onChange={e => setEndpoint(e.target.value)} placeholder="https://account.r2.cloudflarestorage.com" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="s3-bucket">Bucket</Label>
                  <Input id="s3-bucket" value={bucket} onChange={e => setBucket(e.target.value)} placeholder="vox-artifacts" />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="s3-region">Region</Label>
                <Input id="s3-region" value={region} onChange={e => setRegion(e.target.value)} placeholder="auto" />
                <p className="text-xs text-muted-foreground">Use "auto" for Cloudflare R2, or a specific region like "us-east-1" for AWS S3.</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="s3-key">Access Key ID</Label>
                  <Input id="s3-key" value={accessKeyId} onChange={e => setAccessKeyId(e.target.value)} placeholder={hasExistingConfig ? config.s3AccessKeyId : "Enter access key"} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="s3-secret">Secret Access Key</Label>
                  <Input id="s3-secret" type="password" value={secretAccessKey} onChange={e => setSecretAccessKey(e.target.value)} placeholder={hasExistingConfig ? "Enter new secret to update" : "Enter secret key"} />
                </div>
              </div>
              <div className="flex gap-3 pt-2">
                <Button onClick={() => saveMutation.mutate()} disabled={!canSave || saveMutation.isPending} className="gap-2">
                  <Save className="h-4 w-4" />
                  {saveMutation.isPending ? "Saving..." : "Save"}
                </Button>
                {hasExistingConfig && (
                  <Button variant="outline" onClick={() => setDeleteOpen(true)} className="gap-2 text-destructive">
                    <Trash2 className="h-4 w-4" />
                    Remove
                  </Button>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Storage Config</AlertDialogTitle>
            <AlertDialogDescription>
              Your eval artifacts will use the system default storage. Existing artifacts in your bucket will not be deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleteMutation.mutate()} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
