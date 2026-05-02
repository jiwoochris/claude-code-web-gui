import { Lnb } from "@/components/Lnb";
import { FilesProvider } from "@/components/files/FilesProvider";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <FilesProvider>
      <div className="app-shell">
        <Lnb />
        <main className="main">{children}</main>
      </div>
    </FilesProvider>
  );
}
