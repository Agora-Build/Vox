import Console from "@/pages/console";
import ConsoleLayout from "@/components/console-layout";
import ProtectedRoute from "@/components/ProtectedRoute";

export default function AdminConsolePage() {
  return (
    <ProtectedRoute requireAdmin>
      <ConsoleLayout>
        <Console />
      </ConsoleLayout>
    </ProtectedRoute>
  );
}
