import { Lnb } from "@/components/Lnb";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <Lnb />
      <main className="main">{children}</main>
    </div>
  );
}
