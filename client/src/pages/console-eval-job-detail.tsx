import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ArrowLeft, Download, CheckCircle, XCircle, Loader2, Clock, Play } from "lucide-react";
import { Link } from "wouter";
import { formatSmartTimestamp, formatRegion } from "@/lib/utils";
import type { EvalJob, EvalResult } from "@shared/schema";

interface ArtifactFile {
  name: string;
  url: string;
  size: number;
  contentType: string;
}

interface JobDetailResponse {
  job: EvalJob;
  result: EvalResult | null;
  workflowName: string;
  creatorName: string | null;
}

const STATUS_CONFIG: Record<string, { variant: "default" | "destructive" | "secondary" | "outline"; icon: React.ElementType; label: string }> = {
  completed: { variant: "default", icon: CheckCircle, label: "Completed" },
  failed: { variant: "destructive", icon: XCircle, label: "Failed" },
  running: { variant: "secondary", icon: Loader2, label: "Running" },
  pending: { variant: "outline", icon: Clock, label: "Pending" },
};

export default function ConsoleEvalJobDetail({ jobId }: { jobId: number }) {
  const { data, isLoading } = useQuery<JobDetailResponse>({
    queryKey: [`/api/eval-jobs/${jobId}/detail`],
    refetchInterval: (query) => {
      const status = query.state.data?.job.status;
      return status === "pending" || status === "running" ? 5000 : false;
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-4">
        <Link href="/console/eval-jobs?tab=jobs">
          <Button variant="ghost" size="sm" className="gap-2"><ArrowLeft className="h-4 w-4" /> Back to Jobs</Button>
        </Link>
        <p className="text-muted-foreground">Job not found.</p>
      </div>
    );
  }

  const { job, result, workflowName, creatorName } = data;
  const statusCfg = STATUS_CONFIG[job.status] ?? STATUS_CONFIG.pending;
  const StatusIcon = statusCfg.icon;

  const artifactFiles = (result?.artifactFiles ?? []) as ArtifactFile[];
  const artifactUrl = result?.artifactUrl as string | null;
  const rawData = (result?.rawData ?? {}) as Record<string, unknown>;

  // Extract turn-level data from rawData or from known metrics structure
  const responseTurns = (rawData?.response_metrics as Record<string, unknown>)?.latency as Record<string, unknown> | undefined;
  const turnLevel = (responseTurns?.turn_level ?? []) as Array<Record<string, number>>;
  const interruptTurns = ((rawData?.interruption_metrics as Record<string, unknown>)?.latency as Record<string, unknown>)?.turn_level as Array<Record<string, number>> | undefined;

  // Find audio file
  const audioFile = artifactFiles.find(f => f.name.includes('recording'));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <Link href="/console/eval-jobs?tab=jobs">
            <Button variant="ghost" size="sm" className="gap-2"><ArrowLeft className="h-4 w-4" /> Back</Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-3">
              Job #{job.id}
              <Badge variant={statusCfg.variant} className="gap-1">
                <StatusIcon className={`h-3 w-3${job.status === "running" ? " animate-spin" : ""}`} />
                {statusCfg.label}
              </Badge>
            </h1>
            <p className="text-muted-foreground text-sm">
              {workflowName} / {formatRegion(job.region)}
              {creatorName && ` / by ${creatorName}`}
            </p>
          </div>
        </div>
        {artifactUrl && (
          <a href={artifactUrl} download>
            <Button variant="outline" className="gap-2">
              <Download className="h-4 w-4" /> Download Artifacts
            </Button>
          </a>
        )}
      </div>

      {/* Error */}
      {job.error && (
        <Card className="border-destructive/50">
          <CardContent className="pt-6">
            <p className="text-sm text-destructive font-mono">{job.error}</p>
          </CardContent>
        </Card>
      )}

      {/* Timestamps */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div>
          <p className="text-xs text-muted-foreground">Created</p>
          <p className="text-sm font-mono">{formatSmartTimestamp(job.createdAt)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Started</p>
          <p className="text-sm font-mono">{job.startedAt ? formatSmartTimestamp(job.startedAt) : "-"}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Completed</p>
          <p className="text-sm font-mono">{job.completedAt ? formatSmartTimestamp(job.completedAt) : "-"}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Duration</p>
          <p className="text-sm font-mono">
            {job.startedAt && job.completedAt
              ? `${Math.round((new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime()) / 1000)}s`
              : "-"}
          </p>
        </div>
      </div>

      {/* Metrics */}
      {result && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Response Latency</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              <div className="flex justify-between"><span className="text-sm text-muted-foreground">MED</span><span className="text-xl font-bold font-mono">{result.responseLatencyMedian}ms</span></div>
              <div className="flex justify-between"><span className="text-sm text-muted-foreground">SD</span><span className="text-sm font-mono text-muted-foreground">{Math.round(result.responseLatencySd)}ms</span></div>
              <div className="flex justify-between"><span className="text-sm text-muted-foreground">P95</span><span className="text-sm font-mono text-muted-foreground">{result.responseLatencyP95}ms</span></div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Interrupt Latency</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              <div className="flex justify-between"><span className="text-sm text-muted-foreground">MED</span><span className="text-xl font-bold font-mono">{result.interruptLatencyMedian}ms</span></div>
              <div className="flex justify-between"><span className="text-sm text-muted-foreground">SD</span><span className="text-sm font-mono text-muted-foreground">{Math.round(result.interruptLatencySd)}ms</span></div>
              <div className="flex justify-between"><span className="text-sm text-muted-foreground">P95</span><span className="text-sm font-mono text-muted-foreground">{result.interruptLatencyP95}ms</span></div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Other Metrics</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              <div className="flex justify-between"><span className="text-sm text-muted-foreground">Network</span><span className="text-sm font-mono">{result.networkResilience ?? "-"}%</span></div>
              <div className="flex justify-between"><span className="text-sm text-muted-foreground">Naturalness</span><span className="text-sm font-mono">{result.naturalness ?? "-"}/5</span></div>
              <div className="flex justify-between"><span className="text-sm text-muted-foreground">Noise Red.</span><span className="text-sm font-mono">{result.noiseReduction ?? "-"}%</span></div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Audio Player */}
      {audioFile && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Play className="h-4 w-4" />
              Recording
            </CardTitle>
            <CardDescription>{audioFile.name} ({Math.round(audioFile.size / 1024)}KB)</CardDescription>
          </CardHeader>
          <CardContent>
            <audio controls className="w-full" src={audioFile.url}>
              Your browser does not support the audio element.
            </audio>
          </CardContent>
        </Card>
      )}

      {/* Turn-Level Data */}
      {turnLevel.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Response Turn-Level Latency</CardTitle>
            <CardDescription>{turnLevel.length} turn{turnLevel.length !== 1 ? "s" : ""}</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Turn</TableHead>
                  <TableHead className="text-right">Latency (ms)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {turnLevel.map((turn, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono">{turn.turn_index ?? i + 1}</TableCell>
                    <TableCell className="text-right font-mono">{Math.round(turn.latency_ms)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Interrupt Turn-Level Data */}
      {interruptTurns && interruptTurns.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Interrupt Turn-Level Latency</CardTitle>
            <CardDescription>{interruptTurns.length} interruption{interruptTurns.length !== 1 ? "s" : ""}</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Turn</TableHead>
                  <TableHead className="text-right">Reaction Time (ms)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {interruptTurns.map((turn, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono">{turn.turn_index ?? i + 1}</TableCell>
                    <TableCell className="text-right font-mono">{Math.round(turn.reaction_time_ms ?? turn.latency_ms)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Artifact Files */}
      {artifactFiles.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Artifact Files</CardTitle>
            <CardDescription>{artifactFiles.length} file{artifactFiles.length !== 1 ? "s" : ""} uploaded</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>File</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {artifactFiles.map((f, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono text-sm">{f.name}</TableCell>
                    <TableCell className="text-right text-sm text-muted-foreground">{Math.round(f.size / 1024)}KB</TableCell>
                    <TableCell className="text-right">
                      <a href={f.url} target="_blank" rel="noopener noreferrer">
                        <Button variant="ghost" size="sm" className="gap-1">
                          <Download className="h-3 w-3" /> View
                        </Button>
                      </a>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
