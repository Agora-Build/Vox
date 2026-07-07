import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GradientAvatar } from "@/components/gradient-avatar";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface ProfileUser {
  username: string;
  email: string;
  hasPassword?: boolean;
}

export function ProfileDialog({
  user,
  open,
  onOpenChange,
}: {
  user: ProfileUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [name, setName] = useState(user.username);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  // Reset fields whenever the dialog (re)opens.
  useEffect(() => {
    if (open) {
      setName(user.username);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    }
  }, [open, user.username]);

  const nameMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", "/api/user/profile", { username: name.trim() });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/status"] });
      toast({ title: "Name updated" });
    },
    onError: (e: Error) => toast({ title: "Couldn't update name", description: e.message, variant: "destructive" }),
  });

  const passwordMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/user/change-password", {
        currentPassword: user.hasPassword ? currentPassword : undefined,
        newPassword,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/status"] });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast({ title: "Password updated" });
    },
    onError: (e: Error) => toast({ title: "Couldn't update password", description: e.message, variant: "destructive" }),
  });

  const nameChanged = name.trim().length >= 2 && name.trim() !== user.username;
  const passwordValid =
    newPassword.length >= 8 &&
    newPassword === confirmPassword &&
    (!user.hasPassword || currentPassword.length > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Account</DialogTitle>
          <DialogDescription>Manage your name and password.</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-3 py-2">
          <GradientAvatar name={name || user.username} className="h-12 w-12 text-lg" />
          <div className="min-w-0">
            <div className="font-medium truncate">{name || user.username}</div>
            <div className="text-sm text-muted-foreground truncate">{user.email}</div>
          </div>
        </div>

        {/* Display name */}
        <div className="space-y-2">
          <Label htmlFor="profile-name">Display name</Label>
          <div className="flex gap-2">
            <Input
              id="profile-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={50}
              data-testid="input-profile-name"
            />
            <Button
              onClick={() => nameMutation.mutate()}
              disabled={!nameChanged || nameMutation.isPending}
              data-testid="button-save-name"
            >
              Save
            </Button>
          </div>
        </div>

        <div className="h-px bg-border my-1" />

        {/* Password */}
        <div className="space-y-3">
          <Label>{user.hasPassword ? "Change password" : "Set a password"}</Label>
          {user.hasPassword && (
            <Input
              type="password"
              placeholder="Current password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              data-testid="input-current-password"
            />
          )}
          <Input
            type="password"
            placeholder="New password (min 8 characters)"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            data-testid="input-new-password"
          />
          <Input
            type="password"
            placeholder="Confirm new password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            data-testid="input-confirm-password"
          />
          {confirmPassword.length > 0 && newPassword !== confirmPassword && (
            <p className="text-xs text-destructive">Passwords don't match.</p>
          )}
          <Button
            onClick={() => passwordMutation.mutate()}
            disabled={!passwordValid || passwordMutation.isPending}
            className="w-full"
            data-testid="button-save-password"
          >
            {user.hasPassword ? "Update password" : "Set password"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
