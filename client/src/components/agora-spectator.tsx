import { useEffect, useRef, useState, useCallback } from "react";
import AgoraRTC, {
  type IAgoraRTCClient,
  type IRemoteAudioTrack,
} from "agora-rtc-sdk-ng";
import { Badge } from "@/components/ui/badge";
import { Volume2, VolumeX, Wifi, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";

interface AgoraSpectatorProps {
  appId: string;
  channelId: string;
  token: string;
  uid: number;
}

type ConnectionState = "connecting" | "connected" | "disconnected" | "failed";

export default function AgoraSpectator({ appId, channelId, token, uid }: AgoraSpectatorProps) {
  const clientRef = useRef<IAgoraRTCClient | null>(null);
  const [state, setState] = useState<ConnectionState>("connecting");
  const [muted, setMuted] = useState(false);
  const [remoteUsers, setRemoteUsers] = useState<number>(0);
  const tracksRef = useRef<IRemoteAudioTrack[]>([]);

  const cleanup = useCallback(async () => {
    for (const track of tracksRef.current) {
      track.stop();
    }
    tracksRef.current = [];
    if (clientRef.current) {
      await clientRef.current.leave().catch(() => {});
      clientRef.current = null;
    }
  }, []);

  useEffect(() => {
    const client = AgoraRTC.createClient({ mode: "live", codec: "vp8", role: "audience" });
    clientRef.current = client;

    client.on("user-published", async (user, mediaType) => {
      if (mediaType !== "audio") return;
      await client.subscribe(user, mediaType);
      const audioTrack = user.audioTrack;
      if (audioTrack) {
        audioTrack.play();
        tracksRef.current.push(audioTrack);
      }
    });

    client.on("user-unpublished", (user, mediaType) => {
      if (mediaType !== "audio") return;
      tracksRef.current = tracksRef.current.filter(t => t !== user.audioTrack);
    });

    client.on("user-joined", () => {
      setRemoteUsers(client.remoteUsers.length);
    });

    client.on("user-left", () => {
      setRemoteUsers(client.remoteUsers.length);
    });

    client.on("connection-state-change", (curState) => {
      if (curState === "CONNECTED") setState("connected");
      else if (curState === "CONNECTING" || curState === "RECONNECTING") setState("connecting");
      else if (curState === "DISCONNECTED") setState("disconnected");
    });

    client
      .join(appId, channelId, token, uid)
      .then(() => {
        setState("connected");
        setRemoteUsers(client.remoteUsers.length);
      })
      .catch((err) => {
        console.error("Agora join failed:", err);
        setState("failed");
      });

    return () => {
      cleanup();
    };
  }, [appId, channelId, token, uid, cleanup]);

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    for (const track of tracksRef.current) {
      if (next) track.stop();
      else track.play();
    }
  };

  const stateConfig: Record<ConnectionState, { color: string; icon: React.ReactNode; label: string }> = {
    connecting: { color: "bg-yellow-500/10 text-yellow-500", icon: <Wifi className="h-3 w-3 animate-pulse" />, label: "Connecting..." },
    connected: { color: "bg-green-500/10 text-green-500", icon: <Wifi className="h-3 w-3" />, label: "Live" },
    disconnected: { color: "bg-muted text-muted-foreground", icon: <WifiOff className="h-3 w-3" />, label: "Disconnected" },
    failed: { color: "bg-red-500/10 text-red-500", icon: <WifiOff className="h-3 w-3" />, label: "Connection Failed" },
  };

  const cfg = stateConfig[state];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge className={cfg.color}>
            {cfg.icon}
            <span className="ml-1">{cfg.label}</span>
          </Badge>
          {state === "connected" && (
            <span className="text-xs text-muted-foreground">
              {remoteUsers} publisher{remoteUsers !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={toggleMute} title={muted ? "Unmute" : "Mute"}>
          {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        </Button>
      </div>
      {state === "connected" && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
          Listening to live audio
        </div>
      )}
      {state === "failed" && (
        <p className="text-sm text-muted-foreground">
          Could not connect to the live audio stream. The match may have ended or the broadcast is unavailable.
        </p>
      )}
    </div>
  );
}
