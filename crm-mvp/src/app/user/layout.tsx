import UserLayoutComponent from "@/components/UserLayout";

export default function UserRootLayout({ children }: { children: React.ReactNode }) {
  return <UserLayoutComponent>{children}</UserLayoutComponent>;
}
