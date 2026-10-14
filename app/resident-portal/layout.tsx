import type { Metadata } from "next";
import { type ReactNode } from "react";
import ResidentSidebar from "@/components/layout/ResidentSidebar";

export const metadata: Metadata = {
  title: "Resident Portal | University Girls Hostel",
  description: "Resident portal for bills, payments, room details, contracts, notices, and requests.",
};

export default function ResidentPortalLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen w-full flex-col lg:flex-row bg-slate-50 text-slate-900">
      <ResidentSidebar />
      <div className="min-w-0 flex-1 flex flex-col">
        {children}
      </div>
    </div>
  );
}
