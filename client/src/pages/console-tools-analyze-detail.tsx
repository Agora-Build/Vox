import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Download, Loader2 } from "lucide-react";
import { formatRegion, formatSmartTimestamp } from "@/lib/utils";
import { EvalResultView } from "@/components/eval-result-view";
import { ANALYSIS_STATUS, formatDuration, type AnalysisRow } from "@/pages/console-tools-analyze";
import type { EvalResult } from "@shared/schema";

// One analysis from Tools → Analyze: what was uploaded, and its result in the
// same view the eval job page uses.

export default function ConsoleToolsAnalyzeDetail({ id }: { id: number }) {
  const { data, isLoading } = useQuery<{ job: AnalysisRow; result: EvalResult | null }>({
    queryKey: [`/api/tools/analyze/${id}`],
    refetchInterval: (q) => {
      const status = q.state.data?.job.status;
      return status === "pending" || status === "running" ? 10_000 : false;
    },
  });

  const back = (
    <Link href="/console/tools/analyze">
      <Button variant="ghost" size="sm" className="gap-2"><ArrowLeft className="h-4 w-4" /> Analyze</Button>
    </Link>
  );

  if (isLoading) return <div className="space-y-6"><Skeleton className="h-8 w-48" /><Skeleton className="h-48 w-full" /></div>;
  if (!data) return <div className="space-y-4">{back}<p className="text-muted-foreground">Analysis not found.</p></div>;

  const { job, result } = data;
  const st = ANALYSIS_STATUS[job.status];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          {back}
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-3" data-testid="analysis-title">
              {job.fileName ?? `Analysis #${job.id}`}
              <Badge variant={st.variant} className="gap-1">
                <st.icon className={`h-3 w-3${job.status === "running" ? " animate-spin" : ""}`} /> {st.label}
              </Badge>
            </h1>
            <p className="text-muted-foreground text-sm">
              {job.provider?.name ?? "-"}
              {" · "}recorded in {job.recordingRegion ? formatRegion(job.recordingRegion) : "-"}
              {" · "}{job.source === "phone" ? "phone call" : "web session"}
              {" · "}{formatDuration(job.durationSec)}
              {" · "}submitted {formatSmartTimestamp(job.createdAt)}
            </p>
          </div>
        </div>
        <a href={`/api/tools/analyze/${job.id}/recording`} download>
          <Button variant="outline" className="gap-2" data-testid="analysis-download"><Download className="h-4 w-4" /> Download recording</Button>
        </a>
      </div>

      {job.status === "failed" && (
        <Card className="border-destructive/50">
          <CardContent className="pt-6">
            <p className="text-sm text-destructive font-mono">{job.error ?? "The analysis failed."}</p>
          </CardContent>
        </Card>
      )}

      {(job.status === "pending" || job.status === "running") && (
        <Card>
          <CardContent className="pt-6 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {job.status === "pending"
              ? "Waiting for an eval agent. Analyses run after scheduled evals, so this can take a few minutes. If no agent can take it within a day, it fails."
              : "Analyzing the recording…"}
          </CardContent>
        </Card>
      )}

      {result && <EvalResultView result={result} />}
    </div>
  );
}
