import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Server, MapPin, Activity, Clock } from "lucide-react";

interface Worker {
  id: number;
  name: string;
  region: string;
  status: "online" | "offline" | "busy";
  lastHeartbeat: string | null;
  createdAt: string;
}

const REGIONS = [
  { value: "na", label: "North America" },
  { value: "apac", label: "Asia Pacific" },
  { value: "eu", label: "Europe" },
];

function getStatusBadge(status: string) {
  switch (status) {
    case "online":
      return <Badge className="bg-green-500">Online</Badge>;
    case "busy":
      return <Badge className="bg-yellow-500">Busy</Badge>;
    case "offline":
    default:
      return <Badge variant="secondary">Offline</Badge>;
  }
}

function formatLastSeen(lastHeartbeat: string | null) {
  if (!lastHeartbeat) return "Never";
  
  const date = new Date(lastHeartbeat);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  
  return date.toLocaleDateString();
}

export default function ConsoleWorkers() {
  const { data: workers, isLoading } = useQuery<Worker[]>({
    queryKey: ["/api/workers"],
    refetchInterval: 30000,
  });

  const onlineCount = workers?.filter(w => w.status === "online").length || 0;
  const busyCount = workers?.filter(w => w.status === "busy").length || 0;
  const offlineCount = workers?.filter(w => w.status === "offline").length || 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Workers</h1>
        <p className="text-muted-foreground">View registered worker agents across all regions</p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Online</CardTitle>
            <Activity className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-500">{onlineCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Busy</CardTitle>
            <Activity className="h-4 w-4 text-yellow-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-yellow-500">{busyCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Offline</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-muted-foreground">{offlineCount}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="h-5 w-5" />
            Registered Workers
          </CardTitle>
          <CardDescription>
            Worker agents that have registered with the system. Workers fetch and execute benchmark jobs for their assigned region.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : workers && workers.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Region</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last Seen</TableHead>
                  <TableHead>Registered</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workers.map((worker) => (
                  <TableRow key={worker.id}>
                    <TableCell className="font-medium">{worker.name}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="gap-1">
                        <MapPin className="h-3 w-3" />
                        {REGIONS.find(r => r.value === worker.region)?.label || worker.region}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {getStatusBadge(worker.status)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <div className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {formatLastSeen(worker.lastHeartbeat)}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(worker.createdAt).toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              No workers registered yet. Workers will appear here once they connect using a valid token.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
