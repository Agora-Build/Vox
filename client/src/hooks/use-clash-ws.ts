import { useState, useEffect, useRef } from "react";

interface MetricsFrame {
  type: "metrics";
  [key: string]: unknown;
}

interface TranscriptFrame {
  type: "transcript";
  speakerLabel: string;
  text: string;
  startMs: number;
}

interface StatusFrame {
  type: "status";
  phase: string;
}

interface SpectatorCountFrame {
  type: "spectatorCount";
  count: number;
}

type ClashFrame = MetricsFrame | TranscriptFrame | StatusFrame | SpectatorCountFrame;

interface UseClashWsReturn {
  connected: boolean;
  spectatorCount: number;
  transcripts: TranscriptFrame[];
  latestMetrics: MetricsFrame | null;
  phase: string;
}

export function useClashWs(matchId: number | null): UseClashWsReturn {
  const [connected, setConnected] = useState(false);
  const [spectatorCount, setSpectatorCount] = useState(0);
  const [transcripts, setTranscripts] = useState<TranscriptFrame[]>([]);
  const [latestMetrics, setLatestMetrics] = useState<MetricsFrame | null>(null);
  const [phase, setPhase] = useState("waiting");
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!matchId) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/clash/${matchId}`);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);

    ws.onmessage = (event) => {
      try {
        const frame: ClashFrame = JSON.parse(event.data);
        switch (frame.type) {
          case "spectatorCount":
            setSpectatorCount(frame.count);
            break;
          case "transcript":
            setTranscripts(prev => [...prev, frame]);
            break;
          case "metrics":
            setLatestMetrics(frame);
            break;
          case "status":
            setPhase(frame.phase);
            break;
        }
      } catch {}
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [matchId]);

  return { connected, spectatorCount, transcripts, latestMetrics, phase };
}
