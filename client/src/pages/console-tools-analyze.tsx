import { useQuery, useMutation } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { AudioWaveform, CheckCircle, Clock, FileAudio, HardDrive, Loader2, Trash2, Upload, X, XCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatRegion, formatSmartTimestamp, type RegionLocation } from "@/lib/utils";
import { parseWavHeader, analyzeWavError, ANALYZE_HEADER_BYTES } from "@shared/wav";

// Tools → Analyze: upload stereo recordings (left = user, right = agent) and
// get Vox metrics for them. Design: designs/2026-09-30-tools-analyze-design.md.

export interface AnalysisRow {
  id: number;
  status: "pending" | "running" | "completed" | "failed";
  error: string | null;
  fileName: string | null;
  provider: { id: string; name: string } | null;
  recordingRegion: string | null;
  source: "web" | "phone";
  durationSec: number | null;
  createdAt: string;
  completedAt: string | null;
  hasResult: boolean;
}

interface Provider { id: string; name: string }
type Source = "web" | "phone";
interface Choice { provider: string; region: string; source: Source | "" }
interface PickedFile { file: File; durationSec: number | null; problem: string | null; choice: Choice }

const MAX_FILES = 10;
const EMPTY: Choice = { provider: "", region: "", source: "" };

export const ANALYSIS_STATUS: Record<AnalysisRow["status"], { label: string; icon: React.ElementType; variant: "default" | "destructive" | "secondary" | "outline" }> = {
  pending: { label: "Queued", icon: Clock, variant: "outline" },
  running: { label: "Analyzing", icon: Loader2, variant: "secondary" },
  completed: { label: "Done", icon: CheckCircle, variant: "default" },
  failed: { label: "Failed", icon: XCircle, variant: "destructive" },
};

export const formatDuration = (sec: number | null | undefined) => {
  if (sec == null) return "-";
  const s = Math.round(sec);
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
};

/** Check a file in the browser: only its header, so a large file costs nothing. */
async function checkFile(file: File): Promise<Pick<PickedFile, "durationSec" | "problem">> {
  const head = new Uint8Array(await file.slice(0, ANALYZE_HEADER_BYTES).arrayBuffer());
  const info = parseWavHeader(head, file.size);
  const problem = analyzeWavError(info, file.size);
  return { durationSec: "error" in info ? null : info.durationSec, problem };
}

function ChoiceSelects({ choice, onChange, providers, regions, testId }: {
  choice: Choice; onChange: (c: Choice) => void; providers: Provider[]; regions: RegionLocation[]; testId: string;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      <Select value={choice.provider} onValueChange={(provider) => onChange({ ...choice, provider })}>
        <SelectTrigger data-testid={`${testId}-provider`} aria-label="Provider"><SelectValue placeholder="Provider" /></SelectTrigger>
        <SelectContent>
          {providers.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
        </SelectContent>
      </Select>
      <Select value={choice.region} onValueChange={(region) => onChange({ ...choice, region })}>
        <SelectTrigger data-testid={`${testId}-region`} aria-label="Region the recording was made in"><SelectValue placeholder="Region it was recorded in" /></SelectTrigger>
        <SelectContent>
          {regions.filter((r) => r.isActive).map((r) => <SelectItem key={r.baseId} value={r.baseId}>{formatRegion(r.baseId)}</SelectItem>)}
        </SelectContent>
      </Select>
      <Select value={choice.source} onValueChange={(source) => onChange({ ...choice, source: source as Source })}>
        <SelectTrigger data-testid={`${testId}-source`} aria-label="Where the recording came from"><SelectValue placeholder="Source" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="web">Web session</SelectItem>
          <SelectItem value="phone">Phone call</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

const complete = (c: Choice) => !!(c.provider && c.region && c.source);

export default function ConsoleToolsAnalyze() {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<PickedFile[]>([]);
  const [sameForAll, setSameForAll] = useState(true);
  const [shared, setShared] = useState<Choice>(EMPTY);
  const [dragging, setDragging] = useState(false);
  const [deleting, setDeleting] = useState<AnalysisRow | null>(null);

  const { data: auth } = useQuery<{ user: { plan: string } | null }>({ queryKey: ["/api/auth/status"] });
  const isBasic = auth?.user?.plan === "basic";
  const { data: storageConfig, isLoading: storageLoading } = useQuery<unknown | null>({
    queryKey: ["/api/user/storage-config"],
    enabled: !!auth?.user && !isBasic,
  });
  const ready = !!auth?.user && !isBasic && !!storageConfig;
  const { data: providers = [] } = useQuery<Provider[]>({ queryKey: ["/api/providers"], enabled: ready });
  const { data: regions = [] } = useQuery<RegionLocation[]>({ queryKey: ["/api/region-locations"], enabled: ready });
  const { data: analyses, isLoading: listLoading } = useQuery<AnalysisRow[]>({
    queryKey: ["/api/tools/analyze"],
    enabled: ready,
    refetchInterval: (q) => (q.state.data ?? []).some((a) => a.status === "pending" || a.status === "running") ? 10_000 : false,
  });

  const addFiles = async (list: FileList | File[]) => {
    const files = Array.from(list);
    const room = MAX_FILES - picked.length;
    if (files.length > room) toast({ title: `Up to ${MAX_FILES} files at a time`, description: `Only the first ${Math.max(room, 0)} were added.` });
    const checked = await Promise.all(files.slice(0, Math.max(room, 0)).map(async (file) => ({ file, ...(await checkFile(file)), choice: EMPTY })));
    setPicked((p) => [...p, ...checked]);
  };

  const choiceFor = (f: PickedFile) => (sameForAll ? shared : f.choice);
  const canSubmit = picked.length > 0 && picked.every((f) => !f.problem && complete(choiceFor(f)));

  const upload = useMutation({
    mutationFn: async () => {
      const failed: string[] = [];
      for (const f of picked) {
        const c = choiceFor(f);
        const q = new URLSearchParams({ provider: c.provider, region: c.region, source: c.source, fileName: f.file.name });
        const res = await fetch(`/api/tools/analyze?${q}`, {
          method: "POST", credentials: "include", headers: { "Content-Type": "audio/wav" }, body: f.file,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          failed.push(`${f.file.name}: ${body.error ?? res.statusText}`);
        }
      }
      return { sent: picked.length, failed };
    },
    onSuccess: ({ sent, failed }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/tools/analyze"] });
      if (failed.length === 0) {
        toast({ title: sent === 1 ? "Analysis queued" : `${sent} analyses queued`, description: "Results appear below when the analysis is done." });
        setPicked([]);
      } else {
        toast({ title: `${failed.length} of ${sent} not queued`, description: failed.join("\n"), variant: "destructive" });
        setPicked((p) => p.filter((f) => failed.some((m) => m.startsWith(`${f.file.name}:`))));
      }
    },
  });

  const remove = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("DELETE", `/api/tools/analyze/${id}`);
      // 200 (not 204): removed from Vox, but the file stayed in storage the
      // user no longer has configured.
      return res.status === 200 ? (await res.json()) as { leftInStorage?: { endpoint: string; bucket: string; key: string } } : {};
    },
    onSuccess: ({ leftInStorage }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/tools/analyze"] });
      toast(leftInStorage
        ? { title: "Analysis deleted from Vox", description: `Your storage settings changed since the upload, so the recording is still in bucket "${leftInStorage.bucket}" at ${leftInStorage.endpoint} (${leftInStorage.key}). Delete it there if you no longer need it.` }
        : { title: "Analysis deleted", description: "The recording was removed from your storage too." });
    },
    onError: (e: Error) => toast({ title: "Couldn't delete the analysis", description: e.message, variant: "destructive" }),
  });

  const header = (
    <div>
      <h1 className="text-2xl font-bold flex items-center gap-2"><AudioWaveform className="h-6 w-6" /> Analyze</h1>
      <p className="text-muted-foreground">Get Vox metrics for a conversation you already recorded.</p>
    </div>
  );

  if (!auth?.user || (!isBasic && storageLoading)) {
    return <div className="space-y-6">{header}<Skeleton className="h-48 w-full" /></div>;
  }

  if (isBasic || !storageConfig) {
    return (
      <div className="space-y-6">
        {header}
        <Card data-testid="analyze-needs-storage">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><HardDrive className="h-5 w-5" />
              {isBasic ? "Analyze needs Premium" : "Set up your storage first"}
            </CardTitle>
            <CardDescription>
              {isBasic
                ? "Recordings are kept in your own storage, which is a Premium feature."
                : "Recordings you upload are kept in your own bucket, not on Vox. Add it on the Storage page, then come back here."}
            </CardDescription>
          </CardHeader>
          {!isBasic && (
            <CardContent>
              <Link href="/console/storage-settings"><Button>Set up storage</Button></Link>
            </CardContent>
          )}
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {header}

      <Card data-testid="analyze-upload">
        <CardHeader>
          <CardTitle>Upload recordings</CardTitle>
          <CardDescription>Stereo WAV: left channel = user, right channel = agent. Up to {MAX_FILES} files, 100 MB and 30 minutes each.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            className={`rounded-md border-2 border-dashed p-6 text-center transition-colors ${dragging ? "border-primary bg-primary/5" : "border-muted-foreground/25"}`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); void addFiles(e.dataTransfer.files); }}
          >
            <FileAudio className="mx-auto h-8 w-8 text-muted-foreground" />
            <p className="mt-2 text-sm text-muted-foreground">Drop WAV files here, or</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => inputRef.current?.click()} disabled={picked.length >= MAX_FILES}>
              Choose files
            </Button>
            <input
              ref={inputRef} type="file" accept=".wav,audio/wav" multiple className="hidden" data-testid="analyze-file-input"
              onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ""; }}
            />
          </div>

          {picked.length > 0 && (
            <>
              {picked.length > 1 && (
                <div className="flex items-center gap-2">
                  <Switch id="same-for-all" checked={sameForAll} onCheckedChange={setSameForAll} />
                  <Label htmlFor="same-for-all">Same settings for all files</Label>
                </div>
              )}
              {sameForAll && <ChoiceSelects choice={shared} onChange={setShared} providers={providers} regions={regions} testId="analyze-all" />}
              <div className="space-y-2">
                {picked.map((f, i) => (
                  <div key={`${f.file.name}-${i}`} className="rounded-md border p-3 space-y-2" data-testid="analyze-file-row">
                    <div className="flex items-center gap-2">
                      <FileAudio className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="text-sm font-medium truncate">{f.file.name}</span>
                      <span className="text-xs text-muted-foreground">{formatDuration(f.durationSec)}</span>
                      <Button variant="ghost" size="icon" className="ml-auto h-7 w-7" aria-label={`Remove ${f.file.name}`}
                        onClick={() => setPicked((p) => p.filter((_, j) => j !== i))}>
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                    {f.problem
                      ? <p className="text-sm text-destructive" data-testid="analyze-file-problem">{f.problem}</p>
                      : !sameForAll && (
                        <ChoiceSelects choice={f.choice} providers={providers} regions={regions} testId={`analyze-file-${i}`}
                          onChange={(choice) => setPicked((p) => p.map((x, j) => (j === i ? { ...x, choice } : x)))} />
                      )}
                  </div>
                ))}
              </div>
              <Button onClick={() => upload.mutate()} disabled={!canSubmit || upload.isPending} className="gap-2" data-testid="analyze-submit">
                {upload.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                {upload.isPending ? "Uploading…" : picked.length === 1 ? "Analyze" : `Analyze ${picked.length} files`}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>My analyses</CardTitle>
          <CardDescription>Finished analyses also appear in My Evals, under the provider and region you chose.</CardDescription>
        </CardHeader>
        <CardContent>
          {listLoading ? <Skeleton className="h-24 w-full" /> : !analyses?.length ? (
            <p className="text-sm text-muted-foreground">No analyses yet. Upload a recording above to start.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Recording</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Region</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Submitted</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {analyses.map((a) => {
                  const st = ANALYSIS_STATUS[a.status];
                  return (
                    <TableRow key={a.id} data-testid="analyze-row">
                      <TableCell>
                        <Link href={`/console/tools/analyze/${a.id}`} className="font-medium text-primary hover:underline">{a.fileName ?? `#${a.id}`}</Link>
                        <span className="ml-2 text-xs text-muted-foreground">{formatDuration(a.durationSec)}</span>
                      </TableCell>
                      <TableCell>{a.provider?.name ?? "-"}</TableCell>
                      <TableCell>{a.recordingRegion ? formatRegion(a.recordingRegion) : "-"}</TableCell>
                      <TableCell>{a.source === "phone" ? "Phone" : "Web"}</TableCell>
                      <TableCell>
                        <Badge variant={st.variant} className="gap-1" title={a.error ?? undefined}>
                          <st.icon className={`h-3 w-3${a.status === "running" ? " animate-spin" : ""}`} /> {st.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{formatSmartTimestamp(a.createdAt)}</TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Delete ${a.fileName ?? a.id}`}
                          disabled={a.status === "running"} title={a.status === "running" ? "Delete it once it finishes" : undefined}
                          onClick={() => setDeleting(a)} data-testid="analyze-delete">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={deleting != null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this analysis?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.fileName ?? "The recording"} and its result will be deleted, and the file removed from your storage. It also leaves My Evals.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (deleting) remove.mutate(deleting.id); setDeleting(null); }} data-testid="analyze-delete-confirm">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
