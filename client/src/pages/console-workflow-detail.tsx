import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { ArrowLeft, Plus, Settings, TestTube, Play, Trash2, Globe, MapPin } from "lucide-react";
import { useState } from "react";
import type { Workflow as WorkflowType, Vendor, TestCase } from "@shared/schema";

interface AuthStatus {
  user: {
    id: string;
    username: string;
    plan: string;
    isAdmin: boolean;
  } | null;
}

const VENDOR_TYPES = [
  { value: "livekit_agent", label: "LiveKit Agent" },
  { value: "agora_convoai", label: "Agora ConvoAI" },
];

const REGIONS = [
  { value: "na", label: "North America" },
  { value: "apac", label: "Asia Pacific" },
  { value: "eu", label: "Europe" },
];

export default function ConsoleWorkflowDetail() {
  const { toast } = useToast();
  const params = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const workflowId = parseInt(params.id || "0");

  const [vendorDialogOpen, setVendorDialogOpen] = useState(false);
  const [vendorName, setVendorName] = useState("");
  const [vendorType, setVendorType] = useState("");
  const [vendorConfig, setVendorConfig] = useState("{}");

  const [testCaseDialogOpen, setTestCaseDialogOpen] = useState(false);
  const [testCaseName, setTestCaseName] = useState("");
  const [testCaseDescription, setTestCaseDescription] = useState("");
  const [testCaseVendorId, setTestCaseVendorId] = useState("");
  const [testCaseRegion, setTestCaseRegion] = useState("");
  const [testCaseConfig, setTestCaseConfig] = useState("{}");

  const { data: authStatus } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });

  const { data: workflow, isLoading: workflowLoading } = useQuery<WorkflowType>({
    queryKey: [`/api/workflows/${workflowId}`],
    enabled: workflowId > 0,
  });

  const { data: vendors, isLoading: vendorsLoading } = useQuery<Vendor[]>({
    queryKey: [`/api/workflows/${workflowId}/vendors`],
    enabled: workflowId > 0,
  });

  const { data: testCases, isLoading: testCasesLoading } = useQuery<TestCase[]>({
    queryKey: [`/api/workflows/${workflowId}/test-cases`],
    enabled: workflowId > 0,
  });

  const createVendorMutation = useMutation({
    mutationFn: async () => {
      let config = {};
      try {
        config = JSON.parse(vendorConfig);
      } catch {
        throw new Error("Invalid JSON in config");
      }
      const res = await apiRequest("POST", `/api/workflows/${workflowId}/vendors`, {
        name: vendorName,
        type: vendorType,
        config,
      });
      return res.json();
    },
    onSuccess: () => {
      setVendorDialogOpen(false);
      setVendorName("");
      setVendorType("");
      setVendorConfig("{}");
      queryClient.invalidateQueries({ queryKey: [`/api/workflows/${workflowId}/vendors`] });
      toast({ title: "Vendor created" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create vendor", description: error.message, variant: "destructive" });
    },
  });

  const deleteVendorMutation = useMutation({
    mutationFn: async (vendorId: number) => {
      const res = await apiRequest("DELETE", `/api/vendors/${vendorId}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/workflows/${workflowId}/vendors`] });
      queryClient.invalidateQueries({ queryKey: [`/api/workflows/${workflowId}/test-cases`] });
      toast({ title: "Vendor deleted" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to delete vendor", description: error.message, variant: "destructive" });
    },
  });

  const createTestCaseMutation = useMutation({
    mutationFn: async () => {
      let config = {};
      try {
        config = JSON.parse(testCaseConfig);
      } catch {
        throw new Error("Invalid JSON in config");
      }
      const res = await apiRequest("POST", `/api/workflows/${workflowId}/test-cases`, {
        name: testCaseName,
        description: testCaseDescription,
        vendorId: parseInt(testCaseVendorId),
        region: testCaseRegion,
        config,
      });
      return res.json();
    },
    onSuccess: () => {
      setTestCaseDialogOpen(false);
      setTestCaseName("");
      setTestCaseDescription("");
      setTestCaseVendorId("");
      setTestCaseRegion("");
      setTestCaseConfig("{}");
      queryClient.invalidateQueries({ queryKey: [`/api/workflows/${workflowId}/test-cases`] });
      toast({ title: "Test case created" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create test case", description: error.message, variant: "destructive" });
    },
  });

  const toggleTestCaseMutation = useMutation({
    mutationFn: async ({ id, isEnabled }: { id: number; isEnabled: boolean }) => {
      const res = await apiRequest("PATCH", `/api/test-cases/${id}`, { isEnabled });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/workflows/${workflowId}/test-cases`] });
      toast({ title: "Test case updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update test case", description: error.message, variant: "destructive" });
    },
  });

  const deleteTestCaseMutation = useMutation({
    mutationFn: async (testCaseId: number) => {
      const res = await apiRequest("DELETE", `/api/test-cases/${testCaseId}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/workflows/${workflowId}/test-cases`] });
      toast({ title: "Test case deleted" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to delete test case", description: error.message, variant: "destructive" });
    },
  });

  const runWorkflowMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/workflows/${workflowId}/run`);
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Workflow started", description: `Created ${data.jobs?.length || 0} jobs` });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to run workflow", description: error.message, variant: "destructive" });
    },
  });

  const isOwner = workflow?.ownerId === authStatus?.user?.id;
  const canModify = isOwner || authStatus?.user?.isAdmin;

  if (workflowLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!workflow) {
    return (
      <div className="space-y-6">
        <Button variant="ghost" onClick={() => setLocation("/console/workflows")}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to Workflows
        </Button>
        <div className="text-center py-8 text-muted-foreground">
          Workflow not found
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <Button variant="ghost" onClick={() => setLocation("/console/workflows")}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
          </Button>
          <div>
            <h1 className="text-2xl font-bold">{workflow.name}</h1>
            {workflow.description && (
              <p className="text-muted-foreground">{workflow.description}</p>
            )}
          </div>
        </div>
        <Button 
          onClick={() => runWorkflowMutation.mutate()}
          disabled={runWorkflowMutation.isPending || !testCases?.length}
        >
          <Play className="mr-2 h-4 w-4" />
          Run Workflow
        </Button>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5" />
              Vendors
            </CardTitle>
            <CardDescription>
              Configure vendor integrations for this workflow
            </CardDescription>
          </div>
          {canModify && (
            <Dialog open={vendorDialogOpen} onOpenChange={setVendorDialogOpen}>
              <DialogTrigger asChild>
                <Button>
                  <Plus className="mr-2 h-4 w-4" />
                  Add Vendor
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add Vendor</DialogTitle>
                  <DialogDescription>
                    Configure a new vendor integration for this workflow.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label htmlFor="vendor-name">Name</Label>
                    <Input
                      id="vendor-name"
                      placeholder="My LiveKit Agent"
                      value={vendorName}
                      onChange={(e) => setVendorName(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="vendor-type">Type</Label>
                    <Select value={vendorType} onValueChange={setVendorType}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select vendor type" />
                      </SelectTrigger>
                      <SelectContent>
                        {VENDOR_TYPES.map((type) => (
                          <SelectItem key={type.value} value={type.value}>
                            {type.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="vendor-config">Configuration (JSON)</Label>
                    <Textarea
                      id="vendor-config"
                      placeholder='{"apiKey": "...", "apiSecret": "..."}'
                      value={vendorConfig}
                      onChange={(e) => setVendorConfig(e.target.value)}
                      className="font-mono text-sm"
                      rows={4}
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    onClick={() => createVendorMutation.mutate()}
                    disabled={createVendorMutation.isPending || !vendorName || !vendorType}
                  >
                    Add Vendor
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}
        </CardHeader>
        <CardContent>
          {vendorsLoading ? (
            <div className="space-y-4">
              {[1, 2].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : vendors && vendors.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Created</TableHead>
                  {canModify && <TableHead className="text-right">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {vendors.map((vendor) => (
                  <TableRow key={vendor.id}>
                    <TableCell className="font-medium">{vendor.name}</TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {VENDOR_TYPES.find(t => t.value === vendor.type)?.label || vendor.type}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(vendor.createdAt).toLocaleDateString()}
                    </TableCell>
                    {canModify && (
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => deleteVendorMutation.mutate(vendor.id)}
                          disabled={deleteVendorMutation.isPending}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              No vendors configured. Add a vendor to get started.
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <TestTube className="h-5 w-5" />
              Test Cases
            </CardTitle>
            <CardDescription>
              Define test cases to run against vendors
            </CardDescription>
          </div>
          {canModify && vendors && vendors.length > 0 && (
            <Dialog open={testCaseDialogOpen} onOpenChange={setTestCaseDialogOpen}>
              <DialogTrigger asChild>
                <Button>
                  <Plus className="mr-2 h-4 w-4" />
                  Add Test Case
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add Test Case</DialogTitle>
                  <DialogDescription>
                    Create a new test case for this workflow.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label htmlFor="testcase-name">Name</Label>
                    <Input
                      id="testcase-name"
                      placeholder="Latency Test NA"
                      value={testCaseName}
                      onChange={(e) => setTestCaseName(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="testcase-description">Description</Label>
                    <Textarea
                      id="testcase-description"
                      placeholder="Test response latency in North America..."
                      value={testCaseDescription}
                      onChange={(e) => setTestCaseDescription(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="testcase-vendor">Vendor</Label>
                    <Select value={testCaseVendorId} onValueChange={setTestCaseVendorId}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select vendor" />
                      </SelectTrigger>
                      <SelectContent>
                        {vendors?.map((vendor) => (
                          <SelectItem key={vendor.id} value={vendor.id.toString()}>
                            {vendor.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="testcase-region">Region</Label>
                    <Select value={testCaseRegion} onValueChange={setTestCaseRegion}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select region" />
                      </SelectTrigger>
                      <SelectContent>
                        {REGIONS.map((region) => (
                          <SelectItem key={region.value} value={region.value}>
                            {region.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="testcase-config">Configuration (JSON)</Label>
                    <Textarea
                      id="testcase-config"
                      placeholder='{"duration": 60, "iterations": 10}'
                      value={testCaseConfig}
                      onChange={(e) => setTestCaseConfig(e.target.value)}
                      className="font-mono text-sm"
                      rows={3}
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    onClick={() => createTestCaseMutation.mutate()}
                    disabled={createTestCaseMutation.isPending || !testCaseName || !testCaseVendorId || !testCaseRegion}
                  >
                    Add Test Case
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}
        </CardHeader>
        <CardContent>
          {testCasesLoading ? (
            <div className="space-y-4">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : testCases && testCases.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Vendor</TableHead>
                  <TableHead>Region</TableHead>
                  <TableHead>Enabled</TableHead>
                  {canModify && <TableHead className="text-right">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {testCases.map((testCase) => {
                  const vendor = vendors?.find(v => v.id === testCase.vendorId);
                  return (
                    <TableRow key={testCase.id}>
                      <TableCell>
                        <div>
                          <div className="font-medium">{testCase.name}</div>
                          {testCase.description && (
                            <div className="text-sm text-muted-foreground">{testCase.description}</div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">
                          {vendor?.name || "Unknown"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="gap-1">
                          <MapPin className="h-3 w-3" />
                          {REGIONS.find(r => r.value === testCase.region)?.label || testCase.region}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={testCase.isEnabled}
                          onCheckedChange={(checked) =>
                            toggleTestCaseMutation.mutate({ id: testCase.id, isEnabled: checked })
                          }
                          disabled={!canModify}
                        />
                      </TableCell>
                      {canModify && (
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => deleteTestCaseMutation.mutate(testCase.id)}
                            disabled={deleteTestCaseMutation.isPending}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              {vendors && vendors.length > 0 
                ? "No test cases yet. Add a test case to get started."
                : "Add a vendor first before creating test cases."
              }
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
