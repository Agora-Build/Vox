import { useRef, useEffect, useState } from "react";

interface TranscriptEntry {
  speakerLabel: string;
  text: string;
  startMs: number;
}

const speakerColors: Record<string, string> = {
  agent_a: "text-blue-400",
  agent_b: "text-red-400",
  moderator: "text-yellow-400",
};

const speakerNames: Record<string, string> = {
  agent_a: "Agent A",
  agent_b: "Agent B",
  moderator: "Moderator",
};

export default function ClashTranscript({ entries, agentAName, agentBName }: {
  entries: TranscriptEntry[];
  agentAName?: string;
  agentBName?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pinToBottom, setPinToBottom] = useState(true);

  useEffect(() => {
    if (pinToBottom && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [entries, pinToBottom]);

  const getName = (label: string) => {
    if (label === "agent_a" && agentAName) return agentAName;
    if (label === "agent_b" && agentBName) return agentBName;
    return speakerNames[label] || label;
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Transcript</span>
        <button
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setPinToBottom(!pinToBottom)}
        >
          {pinToBottom ? "Unpin" : "Pin to bottom"}
        </button>
      </div>
      <div ref={containerRef} className="h-64 overflow-y-auto space-y-2 rounded-md border p-3 bg-muted/30">
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">Waiting for speech...</p>
        ) : (
          entries.map((entry, i) => (
            <div key={i} className="text-sm">
              <span className={`font-medium ${speakerColors[entry.speakerLabel] || "text-muted-foreground"}`}>
                {getName(entry.speakerLabel)}:
              </span>{" "}
              <span className="text-foreground">{entry.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
