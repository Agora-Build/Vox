import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { ArrowRight, KeyRound, Terminal, BookOpen, Laptop } from "lucide-react";

/**
 * The endpoint list is READ FROM THE SPEC at runtime rather than written out
 * here. A hand-kept copy is exactly what rots: the spec itself had four
 * endpoints that no longer existed and a production URL pointing at a domain
 * that never resolved. Narrative below, reference from the source of truth.
 */
interface OpenApiSpec {
  info?: { version?: string };
  servers?: { url: string; description?: string }[];
  paths: Record<string, Record<string, { summary?: string; tags?: string[]; security?: unknown[] }>>;
}

const VERBS = ["get", "post", "put", "patch", "delete"] as const;
const VERB_STYLE: Record<string, string> = {
  get: "text-emerald-600 dark:text-emerald-400",
  post: "text-blue-600 dark:text-blue-400",
  put: "text-amber-600 dark:text-amber-400",
  patch: "text-amber-600 dark:text-amber-400",
  delete: "text-red-600 dark:text-red-400",
};

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="rounded-lg bg-muted p-4 overflow-x-auto text-sm font-mono leading-relaxed">
      {children}
    </pre>
  );
}

export default function ApiDocs() {
  const { data: spec, isLoading } = useQuery<OpenApiSpec>({
    queryKey: ["/api/v1/openapi.json"],
  });

  const base = spec?.servers?.[spec.servers.length - 1]?.url ?? "https://vox.agora.build/api/v1";

  // Group operations by tag so the reference reads the way the API is shaped.
  type EndpointRow = { verb: string; path: string; summary: string; open: boolean };
  const groups: Record<string, EndpointRow[]> = {};
  for (const [path, ops] of Object.entries(spec?.paths ?? {})) {
    for (const verb of VERBS) {
      const op = ops[verb];
      if (!op) continue;
      const tag = op.tags?.[0] ?? "Other";
      if (!groups[tag]) groups[tag] = [];
      groups[tag].push({
        verb,
        path,
        summary: op.summary ?? "",
        open: Array.isArray(op.security) && op.security.length === 0,
      });
    }
  }

  return (
    <div className="space-y-16 animate-in fade-in duration-700 pb-20">
      <section className="space-y-4 pt-6 md:pt-10">
        <Badge variant="secondary" className="px-4 py-1">API</Badge>
        <h1 className="text-3xl sm:text-5xl font-bold tracking-tight">Vox API</h1>
        <p className="text-base sm:text-lg text-muted-foreground max-w-3xl leading-relaxed">
          Create eval flows, run them against your agents, and read the results — over HTTP,
          with an API key. Everything the console does with your evals, you can do here.
        </p>
      </section>

      {/* The two families, stated honestly: one exists, one doesn't yet. */}
      <section className="grid md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2 mb-2">
              <Terminal className="h-5 w-5 text-primary" />
              <Badge>Available now</Badge>
            </div>
            <CardTitle>REST API</CardTitle>
            <CardDescription>
              Served under <code className="font-mono text-xs">/api/v1</code>, authenticated with a
              <code className="font-mono text-xs"> vox_live_</code> key. Evals run on Vox-managed or
              your own eval agents; you schedule and read results over HTTP.
            </CardDescription>
          </CardHeader>
        </Card>
        <Card className="border-dashed">
          <CardHeader>
            <div className="flex items-center gap-2 mb-2">
              <Laptop className="h-5 w-5 text-muted-foreground" />
              <Badge variant="secondary">Planned</Badge>
            </div>
            <CardTitle>Native API</CardTitle>
            <CardDescription>
              Build evals and run them locally against your own agent, without round-tripping
              through this service. Not available yet — it is on the roadmap, and nothing on this
              page depends on it.
            </CardDescription>
          </CardHeader>
        </Card>
      </section>

      {/* Getting started — the part a reference alone can't give you. */}
      <section className="space-y-8">
        <div className="space-y-3">
          <h2 className="text-2xl font-bold">Getting started</h2>
          <p className="text-muted-foreground max-w-3xl">
            Four steps from nothing to a finished eval.
          </p>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <Badge variant="outline" className="h-7 w-7 rounded-full flex items-center justify-center shrink-0">1</Badge>
                <CardTitle className="text-lg flex items-center gap-2">
                  <KeyRound className="h-4 w-4" /> Get an API key
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Sign in, then open <strong>Console → API Keys</strong> and create one. The key is
                shown <strong>once, at creation</strong> — copy it then. Vox stores only a SHA-256
                hash and cannot show it to you again; if you lose it, revoke it and make another.
              </p>
              <Link href="/console/api-keys">
                <Button variant="outline" size="sm" className="gap-2" data-testid="link-api-keys">
                  Open API Keys <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <Badge variant="outline" className="h-7 w-7 rounded-full flex items-center justify-center shrink-0">2</Badge>
                <CardTitle className="text-lg">Check it works</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                <code className="font-mono text-xs">GET /user</code> is the cheapest authenticated call.
              </p>
              <CodeBlock>{`curl -H "Authorization: Bearer vox_live_xxxxx" \\
  ${base}/user`}</CodeBlock>
              <p className="text-sm text-muted-foreground">
                A missing or bad key returns <code className="font-mono text-xs">401</code>; a key
                that can&apos;t see the resource returns <code className="font-mono text-xs">403</code>.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <Badge variant="outline" className="h-7 w-7 rounded-full flex items-center justify-center shrink-0">3</Badge>
                <CardTitle className="text-lg">Know the three objects</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid sm:grid-cols-3 gap-4">
                <div className="space-y-1">
                  <div className="font-semibold text-sm">Eval flow</div>
                  <p className="text-sm text-muted-foreground">
                    How to reach the agent: provider, evaluation mode (web or phone), and the
                    Setup/Teardown steps that connect and hang up.
                  </p>
                </div>
                <div className="space-y-1">
                  <div className="font-semibold text-sm">Eval set</div>
                  <p className="text-sm text-muted-foreground">
                    What to say: the conversation the eval runs. Yours, or a public one.
                  </p>
                </div>
                <div className="space-y-1">
                  <div className="font-semibold text-sm">Job</div>
                  <p className="text-sm text-muted-foreground">
                    One execution of an eval flow against an eval set, on one agent, in one region.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <Badge variant="outline" className="h-7 w-7 rounded-full flex items-center justify-center shrink-0">4</Badge>
                <CardTitle className="text-lg">Run one, then read the result</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <CodeBlock>{`# start a run
curl -X POST -H "Authorization: Bearer vox_live_xxxxx" \\
  -H "Content-Type: application/json" \\
  -d '{"evalSetId": 42, "region": "na-us-seattle", "targetTier": "public"}' \\
  ${base}/eval-flows/1/run

# poll until the job is completed
curl -H "Authorization: Bearer vox_live_xxxxx" ${base}/jobs/123

# then read its metrics
curl -H "Authorization: Bearer vox_live_xxxxx" "${base}/results?jobId=123"`}</CodeBlock>
              <p className="text-sm text-muted-foreground">
                Responses are <code className="font-mono text-xs">{`{ "data": ..., "meta": ... }`}</code>;
                errors are <code className="font-mono text-xs">{`{ "error": "..." }`}</code>. Requests
                are rate limited to 100 per 15 minutes in production.
              </p>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Reference, read from the live spec so it cannot drift. */}
      <section className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-2">
            <h2 className="text-2xl font-bold">Endpoints</h2>
            <p className="text-muted-foreground">
              Read live from the OpenAPI spec, so this list is always what the server serves.
              Open the interactive reference for parameters, schemas and a try-it console.
            </p>
          </div>
          <div className="flex gap-2">
            <a href="/api/docs" target="_blank" rel="noreferrer">
              <Button variant="default" size="sm" className="gap-2" data-testid="link-interactive-reference">
                <BookOpen className="h-4 w-4" /> Interactive reference
              </Button>
            </a>
            <a href="/api/v1/openapi.json" target="_blank" rel="noreferrer">
              <Button variant="outline" size="sm" data-testid="link-openapi-spec">OpenAPI spec</Button>
            </a>
          </div>
        </div>

        {isLoading && <p className="text-sm text-muted-foreground">Loading endpoints…</p>}

        <div className="space-y-6">
          {Object.entries(groups).map(([tag, ops]) => (
            <Card key={tag}>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg">{tag}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {ops.map((op) => (
                  <div
                    key={`${op.verb}-${op.path}`}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-1.5 border-b last:border-0"
                    data-testid={`row-endpoint-${op.verb}-${op.path}`}
                  >
                    <span className={`font-mono text-xs font-bold uppercase w-16 shrink-0 ${VERB_STYLE[op.verb]}`}>
                      {op.verb}
                    </span>
                    <code className="font-mono text-sm">{op.path}</code>
                    {op.open && <Badge variant="secondary" className="text-xs">no key needed</Badge>}
                    <span className="text-sm text-muted-foreground">{op.summary}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}
