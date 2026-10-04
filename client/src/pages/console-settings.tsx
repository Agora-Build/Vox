import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiRequest, queryClient } from "@/lib/queryClient";

export default function PersonalSettings() {
  const security = useQuery<{ totpEnabled: boolean; hasPassword: boolean; emailAvailable: boolean; encryptionConfigured: boolean }>({ queryKey: ["/api/user/security"] });
  const { data: auth } = useQuery<{ user: { isAdmin: boolean } }>({ queryKey: ["/api/auth/status"] });
  const [password, setPassword] = useState("");
  const [initCode, setInitCode] = useState("");
  const [setup, setSetup] = useState<{ qrCode: string; secret: string } | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function run(path: string, body: unknown, done: (data: Record<string, unknown>) => void) {
    setPending(true); setError("");
    try { const data = await (await apiRequest("POST", path, body)).json(); done(data); queryClient.invalidateQueries({ queryKey: ["/api/user/security"] }); }
    catch (e) { setError((e as Error).message); }
    finally { setPending(false); setPassword(""); setInitCode(""); setCode(""); }
  }
  return <div className="mx-auto max-w-3xl space-y-6"><div><h1 className="text-3xl font-semibold tracking-tight">Settings</h1><p className="mt-2 text-muted-foreground">Personal account security. Google sign-in remains your existing login option.</p></div>
    <Card><CardHeader><CardTitle>Google Authenticator</CardTitle><CardDescription>Use time-based one-time codes to approve sensitive admin changes. Any compatible authenticator app works.</CardDescription></CardHeader><CardContent className="space-y-4">
      {security.isLoading ? <p>Loading security settings...</p> : security.isError ? <p role="alert">Could not load security settings.</p> : !security.data?.encryptionConfigured ? <p>Server encryption must be configured before enabling an authenticator or verification codes.</p> : <>
        <p className="text-sm">Authenticator: <strong>{security.data.totpEnabled ? "Enabled" : "Not enabled"}</strong> &middot; Email verification: {security.data.emailAvailable ? "Available" : "Not configured"}</p>
        {security.data.hasPassword && <div className="space-y-2"><Label htmlFor="security-password">Current password</Label><Input id="security-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>}
        {!security.data.hasPassword && auth?.user.isAdmin && <div className="space-y-2"><Label htmlFor="security-init">Initialization code</Label><Input id="security-init" type="password" autoComplete="off" value={initCode} onChange={(e) => setInitCode(e.target.value)} /></div>}
        {!security.data.totpEnabled && !setup && <Button disabled={pending} onClick={() => run("/api/user/security/totp/enroll", { password, initCode }, (data) => setSetup(data as unknown as { qrCode: string; secret: string }))}>Set up authenticator</Button>}
        {setup && <div className="space-y-4 rounded-lg border p-4"><p className="text-sm">Scan this QR code in Google Authenticator, then enter its six-digit code. Setup expires after ten minutes.</p><img src={setup.qrCode} alt="Authenticator enrollment QR code" className="h-48 w-48 rounded bg-white p-2" /><details><summary className="cursor-pointer text-sm">Enter setup key manually</summary><code className="mt-2 block break-all">{setup.secret}</code></details><Label htmlFor="security-code">Authenticator code</Label><Input id="security-code" autoComplete="one-time-code" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} /><Button disabled={pending || code.length !== 6} onClick={() => run("/api/user/security/totp/confirm", { code }, (data) => { setRecoveryCodes(data.recoveryCodes as string[]); setSetup(null); })}>Enable authenticator</Button></div>}
        {!!recoveryCodes.length && <div className="rounded-lg border border-primary/30 p-4"><p className="font-medium">Save your recovery codes now</p><p className="mt-1 text-sm text-muted-foreground">These are shown once. Keep them offline; a recovery code resets the authenticator and invalidates remaining codes.</p><div className="my-3 grid gap-2 font-mono text-xs sm:grid-cols-2">{recoveryCodes.map((value) => <code key={value}>{value}</code>)}</div><Button variant="outline" onClick={() => setRecoveryCodes([])}>I saved these codes</Button></div>}
        {security.data.totpEnabled && <details><summary className="cursor-pointer text-sm">Lost access to your authenticator?</summary><div className="mt-3 space-y-3"><Label htmlFor="security-recovery">Recovery code</Label><Input id="security-recovery" type="password" autoComplete="off" value={recoveryCode} onChange={(e) => setRecoveryCode(e.target.value)} /><Button variant="outline" disabled={pending || !recoveryCode} onClick={() => run("/api/user/security/totp/recover", { password, initCode, recoveryCode }, () => { setRecoveryCode(""); setRecoveryCodes([]); })}>Reset authenticator using recovery code</Button></div></details>}
      </>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </CardContent></Card>
  </div>;
}
