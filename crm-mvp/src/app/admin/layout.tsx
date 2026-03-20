import AdminLayoutComponent from "@/components/AdminLayout";

export default function AdminRootLayout({ children }: { children: React.ReactNode }) {
  return <AdminLayoutComponent>{children}</AdminLayoutComponent>;
}
