import { INTERRUPT_ACTION_MAX_MS } from "@shared/metrics";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Download, Play, Phone } from "lucide-react";
import type { EvalResult } from "@shared/schema";

// One eval result, as the eval job page shows it: call details, the metric
// cards, per-case results, recordings, screenshots, turn-level tables and
// artifact files. Shared with Tools → Analyze, so both pages show a result
// the same way.

interface ArtifactFile {
  name: string;
  url: string;
  size: number;
  contentType: string;
}

export function EvalResultView({ result }: { result: EvalResult }) {
  const artifactFiles = (result.artifactFiles ?? []) as ArtifactFile[];
  const rawData = (result.rawData ?? {}) as Record<string, unknown>;

  // Extract turn-level data from rawData
  const responseMetrics = rawData?.response_metrics as Record<string, unknown> | undefined;
  const responseTurns = (responseMetrics?.latency as Record<string, unknown>)?.turn_level as Array<Record<string, unknown>> | undefined;
  const turnLevel = (responseTurns ?? []) as Array<Record<string, number | string | boolean>>;

  const interruptMetrics = rawData?.interruption_metrics as Record<string, unknown> | undefined;
  const interruptTurns = ((interruptMetrics?.latency as Record<string, unknown>)?.turn_level ?? []) as Array<Record<string, number | string | boolean>>;

  // Per-case breakdown emitted by the daemon for chunked lab runs
  interface CaseStats {
    sample_count: number;
    has_interrupt_phase: boolean;
    false_interrupt_case: boolean;
    response?: { turn_count: number; median_ms: number; p95_ms: number };
    interruption?: { turn_count: number; median_ms: number; p95_ms: number };
  }
  const perCase = (rawData?.per_case ?? {}) as Record<string, CaseStats>;
  const pct = (v: number | null | undefined) => v == null ? "-" : `${Math.round(v * 100)}%`;
  const fmtT = (v: unknown) => v == null ? "-" : `${Number(v).toFixed(1)}s`;
  // null latency = NA (agent didn't respond) — never render it as 0 ms.
  const ms = (v: number | null | undefined) => v == null ? "NA" : `${Math.round(v)}ms`;

  // Split interruptions into true vs false interrupts via each turn's case_id
  // (annotated at merge time). Turns without case_id (single-file runs) are
  // shown as true interrupts.
  const falseCaseIds = new Set(Object.entries(perCase).filter(([, c]) => c.false_interrupt_case).map(([id]) => id));
  const falseIntTurns = interruptTurns.filter(t => falseCaseIds.has(String(t.case_id)));
  const trueIntTurns = interruptTurns.filter(t => !falseCaseIds.has(String(t.case_id)));

  // The Response table shows only response-type cases: interrupt cases also
  // emit response turns (the cut-off answer + the post-material answer), but
  // those belong to the interrupt story, told in the tables below. Turns
  // without case_id (single-file runs, old rows) are kept.
  const interruptCaseIds = new Set(Object.entries(perCase).filter(([, c]) => c.has_interrupt_phase).map(([id]) => id));
  const responseTurnsShown = turnLevel.filter(t => t.case_id == null || !interruptCaseIds.has(String(t.case_id)));

  // An interruption's follow-up: the response turn right after it in the same
  // chunk (source_turn_index + 1) — the agent's answer after the interrupt
  // material (normal_response). Absent for false interrupts that just resume.
  const followUpOf = (turn: Record<string, unknown>) =>
    turn.source_turn_index == null ? undefined : turnLevel.find(r =>
      r.case_id === turn.case_id && r.chunk_id === turn.chunk_id &&
      Number(r.source_turn_index) === Number(turn.source_turn_index) + 1);

  // Find special artifact files
  const audioFiles = artifactFiles.filter(f => /\.(webm|wav|mp3|ogg)$/i.test(f.name) && f.size > 0);
  const screenshotFiles = artifactFiles.filter(f => /\.(png|jpg|jpeg)$/i.test(f.name));

  return (
    <>
    {/* Metrics */}
    {result.callMetadata != null && (() => {
      const cm = result.callMetadata as {
        disposition?: string; answeredAfterMs?: number | null;
        durationMs?: number | null; sim?: string | null; fromRedacted?: string | null;
      };
      const fmtSec = (v: number | null | undefined) => v == null ? "-" : `${(v / 1000).toFixed(1)}s`;
      return (
        <Card data-testid="card-call-details">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2"><Phone className="h-4 w-4" /> Call Details</CardTitle>
            <CardDescription>Carrier call as observed by the phone endpoint</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex justify-between sm:block"><span className="text-sm text-muted-foreground block">Disposition</span><span className="text-sm font-mono">{cm.disposition ?? "-"}</span></div>
            <div className="flex justify-between sm:block"><span className="text-sm text-muted-foreground block">Answered after</span><span className="text-sm font-mono">{fmtSec(cm.answeredAfterMs)}</span></div>
            <div className="flex justify-between sm:block"><span className="text-sm text-muted-foreground block">Duration</span><span className="text-sm font-mono">{fmtSec(cm.durationMs)}</span></div>
            <div className="flex justify-between sm:block"><span className="text-sm text-muted-foreground block">Remote number</span><span className="text-sm font-mono">{cm.fromRedacted ?? "-"}</span></div>
          </CardContent>
        </Card>
      );
    })()}

    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Response Latency</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          <div className="flex justify-between"><span className="text-sm text-muted-foreground">MED</span><span className="text-xl font-bold font-mono">{ms(result.responseLatencyMedian)}</span></div>
          <div className="flex justify-between"><span className="text-sm text-muted-foreground">SD</span><span className="text-sm font-mono text-muted-foreground">{ms(result.responseLatencySd)}</span></div>
          <div className="flex justify-between"><span className="text-sm text-muted-foreground">P95</span><span className="text-sm font-mono text-muted-foreground">{ms(result.responseLatencyP95)}</span></div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm" title="Time for the AI to stop after the user interrupts (barges in) — lower is better">Interrupt Latency</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          <div className="flex justify-between"><span className="text-sm text-muted-foreground">MED</span><span className="text-xl font-bold font-mono">{ms(result.interruptLatencyMedian)}</span></div>
          <div className="flex justify-between"><span className="text-sm text-muted-foreground">SD</span><span className="text-sm font-mono text-muted-foreground">{ms(result.interruptLatencySd)}</span></div>
          <div className="flex justify-between"><span className="text-sm text-muted-foreground">P95</span><span className="text-sm font-mono text-muted-foreground">{ms(result.interruptLatencyP95)}</span></div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm" title="Opportunity-weighted success across responding, stopping on interrupt, and avoiding false barge-in. A no-response turn counts as a failure, so this stays meaningful under network impairment.">Turn Success Rate</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          <div className="flex justify-between items-baseline"><span className="text-sm text-muted-foreground">Overall</span><span className="text-xl font-bold font-mono">{pct(result.turnSuccessRate)}</span></div>
          <div className="mt-1 pt-1 border-t space-y-1">
            <div className="flex justify-between"><span className="text-xs text-muted-foreground">Response</span><span className="text-xs font-mono text-muted-foreground">{pct(result.responseRate)}</span></div>
            <div className="flex justify-between"><span className="text-xs text-muted-foreground">Interrupt</span><span className="text-xs font-mono text-muted-foreground">{pct(result.interruptRate)}</span></div>
            <div className="flex justify-between"><span className="text-xs text-muted-foreground" title="How often the AI barges in before the user finishes speaking — lower is better">False Barge-in ↓</span><span className="text-xs font-mono text-muted-foreground">{pct(result.falseInterruptRate)}</span></div>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Other Metrics</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          <div className="flex justify-between"><span className="text-sm text-muted-foreground">Network</span><span className="text-sm font-mono">{result.networkResilience != null ? `${result.networkResilience}%` : "-"}</span></div>
          <div className="flex justify-between"><span className="text-sm text-muted-foreground">Naturalness</span><span className="text-sm font-mono">{result.naturalness != null ? `${result.naturalness}/5` : "-"}</span></div>
          <div className="flex justify-between"><span className="text-sm text-muted-foreground">Noise Red.</span><span className="text-sm font-mono">{result.noiseReduction != null ? `${result.noiseReduction}%` : "-"}</span></div>
        </CardContent>
      </Card>
    </div>

    {/* Per-case breakdown (chunked lab runs) */}
    {Object.keys(perCase).length > 0 && (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Per-Case Results</CardTitle>
          <CardDescription>Each case aggregated across its chunks</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">Metric</th>
                  <th className="py-2 pr-4 font-medium text-right">Samples</th>
                  <th className="py-2 pr-4 font-medium text-right">Responses</th>
                  <th className="py-2 pr-4 font-medium text-right">Resp MED</th>
                  <th className="py-2 pr-4 font-medium text-right">Resp P95</th>
                  <th className="py-2 pr-4 font-medium text-right" title="Samples where the agent stopped talking (within the reaction threshold)">Reactions</th>
                  <th className="py-2 pr-4 font-medium text-right">Int MED</th>
                  <th className="py-2 font-medium text-right">Int P95</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(perCase)
                  .map(([caseId, c]) => ({
                    caseId,
                    c,
                    label: c.false_interrupt_case ? "False Barge-in ↓" : c.has_interrupt_phase ? "Interrupt" : "Response",
                    order: c.false_interrupt_case ? 2 : c.has_interrupt_phase ? 1 : 0,
                  }))
                  .sort((a, b) => a.order - b.order || a.caseId.localeCompare(b.caseId))
                  .map(({ caseId, c, label }) => (
                  <tr key={caseId} className="border-b last:border-0">
                    <td className="py-2 pr-4">
                      {label}
                      <span className="ml-2 text-xs text-muted-foreground font-mono">{caseId}</span>
                    </td>
                    <td className="py-2 pr-4 text-right font-mono">{c.sample_count}</td>
                    <td className="py-2 pr-4 text-right font-mono">{c.response?.turn_count ?? "-"}</td>
                    <td className="py-2 pr-4 text-right font-mono">{c.response?.turn_count ? `${c.response.median_ms}ms` : "-"}</td>
                    <td className="py-2 pr-4 text-right font-mono">{c.response?.turn_count ? `${c.response.p95_ms}ms` : "-"}</td>
                    <td className="py-2 pr-4 text-right font-mono">{c.has_interrupt_phase ? c.interruption?.turn_count ?? 0 : "-"}</td>
                    <td className="py-2 pr-4 text-right font-mono">{c.interruption?.turn_count ? `${c.interruption.median_ms}ms` : "-"}</td>
                    <td className="py-2 text-right font-mono">{c.interruption?.turn_count ? `${c.interruption.p95_ms}ms` : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    )}

    {/* Audio Player */}
    {audioFiles.length > 0 && (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Play className="h-4 w-4" />
            Recordings
          </CardTitle>
          <CardDescription>{audioFiles.length} audio file{audioFiles.length !== 1 ? "s" : ""}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {audioFiles.map((f, i) => (
            <div key={i} className="space-y-1">
              <p className="text-xs text-muted-foreground font-mono">{f.name} ({Math.round(f.size / 1024)}KB)</p>
              <audio controls className="w-full" src={f.url} />
            </div>
          ))}
        </CardContent>
      </Card>
    )}

    {/* Screenshots */}
    {screenshotFiles.length > 0 && (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Screenshots</CardTitle>
          <CardDescription>{screenshotFiles.length} screenshot{screenshotFiles.length !== 1 ? "s" : ""}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            {screenshotFiles.map((f, i) => (
              <div key={i} className="space-y-1">
                <a href={f.url} target="_blank" rel="noopener noreferrer">
                  <img src={f.url} alt={f.name} className="rounded border w-full cursor-pointer hover:opacity-90 transition" />
                </a>
                <p className="text-xs text-muted-foreground font-mono">{f.name}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    )}

    {/* Response Turn-Level Data */}
    {responseTurnsShown.length > 0 && (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Response Turn-Level Latency</CardTitle>
          <CardDescription>{responseTurnsShown.length} turn{responseTurnsShown.length !== 1 ? "s" : ""}</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Turn</TableHead>
                <TableHead className="text-right">Start</TableHead>
                <TableHead className="text-right">End</TableHead>
                <TableHead className="text-right">Latency (ms)</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Transcript</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {responseTurnsShown.map((turn, i) => (
                <TableRow key={i}>
                  <TableCell className="font-mono">{String(turn.turn_index ?? i + 1)}</TableCell>
                  <TableCell className="text-right font-mono">{fmtT(turn.turn_start)}</TableCell>
                  <TableCell className="text-right font-mono">{fmtT(turn.turn_end)}</TableCell>
                  <TableCell className="text-right font-mono">{Math.round(Number(turn.latency_ms))}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{String(turn.response_kind ?? "")}</TableCell>
                  <TableCell className="text-xs max-w-md">
                    {turn.user_transcript != null && <p className="text-muted-foreground">U: {String(turn.user_transcript)}</p>}
                    {turn.agent_transcript != null && <p>A: {String(turn.agent_transcript)}</p>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    )}

    {/* Interrupt / False Interrupt Turn-Level Data */}
    {[
      { title: "Interrupt Turn-Level Latency", turns: trueIntTurns, noun: "interruption" },
      { title: "False Barge-in Turn-Level Latency", turns: falseIntTurns, noun: "false barge-in" },
    ].filter(s => s.turns.length > 0).map(section => (
      <Card key={section.title}>
        <CardHeader>
          <CardTitle className="text-sm">{section.title}</CardTitle>
          <CardDescription>{section.turns.length} {section.noun}{section.turns.length !== 1 ? "s" : ""}</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Turn</TableHead>
                <TableHead className="text-right">Start</TableHead>
                <TableHead className="text-right">End</TableHead>
                <TableHead className="text-right">Reaction (ms)</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Transcript</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {section.turns.map((turn, i) => {
                const reactionMs = Math.round(Number(turn.interrupt_action_ms ?? turn.reaction_time_ms ?? 0));
                const tooSlow = reactionMs > INTERRUPT_ACTION_MAX_MS;
                const kind = String(turn.interruption_kind ?? "");
                const followUp = followUpOf(turn);
                return (
                <TableRow key={i}>
                  <TableCell className="font-mono">{String(turn.turn_index ?? i + 1)}</TableCell>
                  <TableCell className="text-right font-mono">{fmtT(turn.turn_start)}</TableCell>
                  <TableCell className="text-right font-mono">{fmtT(turn.turn_end)}</TableCell>
                  <TableCell
                    className={`text-right font-mono ${tooSlow ? "text-amber-600 dark:text-amber-400 font-semibold" : ""}`}
                    title={tooSlow ? `Slower than the ${INTERRUPT_ACTION_MAX_MS}ms reaction threshold — not counted as a reaction (agent likely finished naturally)` : undefined}
                  >
                    {reactionMs}{tooSlow ? " ⚠" : ""}
                  </TableCell>
                  <TableCell className={`text-xs ${kind === "user_interrupt_agent" ? "text-amber-600 dark:text-amber-400 font-medium" : "text-muted-foreground"}`}>{kind}</TableCell>
                  <TableCell className="text-xs max-w-md">
                    {turn.user_transcript != null && <p className="text-muted-foreground">U: {String(turn.user_transcript)}</p>}
                    {turn.agent_transcript != null && <p>A: {String(turn.agent_transcript)}</p>}
                    {followUp && (followUp.user_transcript != null || followUp.agent_transcript != null) && (
                      <div className="mt-1 border-l-2 pl-2" title="Follow-up: the agent's response after the interrupt">
                        {followUp.user_transcript != null && <p className="text-muted-foreground">↳ U: {String(followUp.user_transcript)}</p>}
                        {followUp.agent_transcript != null && <p>↳ A: {String(followUp.agent_transcript)}</p>}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    ))}

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
    </>
  );
}
