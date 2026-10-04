import { useEffect, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiRequest } from "@/lib/queryClient";
import type { VerificationProof } from "@vox/plugin-sdk";
import { Link } from "wouter";

export function ProtectedAction({ action, payload, onConfirm, label, disabled = false }: {
  action: "credits.grant" | "payments.pricing"; payload: unknown;
  onConfirm(proof: VerificationProof): Promise<void>; label: string; disabled?: boolean;
}) {
  const id = useId();
  const [method, setMethod] = useState("totp");
  const [initCode, setInitCode] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const fingerprint = JSON.stringify(payload);
  const { data: security } = useQuery<{ totpEnabled: boolean; emailAvailable: boolean }>({ queryKey: ["/api/user/security"] });
  useEffect(() => { setChallengeId(null); setCode(""); setError(""); }, [fingerprint, method]);
  const available = method === "totp" ? security?.totpEnabled : security?.emailAvailable;
  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
      <p className="text-sm font-medium">Confirm this exact change</p>
      <p className="text-xs text-muted-foreground">Requires the initialization code and one fresh verification. Approval is single-use.</p>
      <Label htmlFor={`${id}-init`}>Initialization code</Label>
      <Input id={`${id}-init`} type="password" autoComplete="off" value={initCode} onChange={(e) => setInitCode(e.target.value)} disabled={pending} />
      <Label htmlFor={`${id}-method`}>Verification method</Label>
      <Select value={method} onValueChange={setMethod} disabled={pending}>
        <SelectTrigger id={`${id}-method`}><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="totp">Google Authenticator</SelectItem><SelectItem value="email" disabled={!security?.emailAvailable}>Email code</SelectItem></SelectContent>
      </Select>
      {!available && <p className="text-sm text-muted-foreground"><Link href="/console/settings" className="underline">Set up an authenticator in Settings</Link>, or configure email notifications.</p>}
      {!challengeId ? <Button variant="outline" disabled={disabled || !available || pending} onClick={async () => {
        setPending(true); setError("");
        try {
          const result = await (await apiRequest("POST", "/api/user/verification/challenges", { action, payload, method })).json();
          setChallengeId(result.challengeId); setExpiresAt(result.expiresAt);
        } catch (e) { setError((e as Error).message); } finally { setPending(false); }
      }}>{pending ? "Preparing..." : method === "email" ? "Send verification email" : "Prepare verification"}</Button> : <>
        <Label htmlFor={`${id}-code`}>Six-digit verification code</Label>
        <Input id={`${id}-code`} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} disabled={pending} />
        <p className="text-xs text-muted-foreground">Expires at {expiresAt && new Date(expiresAt).toLocaleTimeString()}. Authenticator codes cannot be reused.</p>
        <Button disabled={disabled || pending || code.length !== 6 || !initCode} onClick={async () => {
          setPending(true); setError("");
          try { await onConfirm({ initCode, code, challengeId }); setInitCode(""); setCode(""); setChallengeId(null); }
          catch (e) { setError((e as Error).message); }
          finally { setPending(false); }
        }}>{pending ? "Confirming..." : label}</Button>
        <Button variant="ghost" disabled={pending} onClick={() => { setChallengeId(null); setCode(""); }}>Start verification again</Button>
      </>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
