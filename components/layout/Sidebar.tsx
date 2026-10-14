"use client";

import { normalizeIdentityEmail } from "@/lib/identity";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import ProfileDropdown from "@/components/layout/ProfileDropdown";
import { isSuperAdmin } from "@/lib/permissions";
import { supabase } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// SVG Navigation Icons (Crisp, modern, 20x20)
// ---------------------------------------------------------------------------

function DashboardIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="7" height="9" x="3" y="3" rx="1.5" />
      <rect width="7" height="5" x="14" y="3" rx="1.5" />
      <rect width="7" height="9" x="14" y="12" rx="1.5" />
      <rect width="7" height="5" x="3" y="16" rx="1.5" />
    </svg>
  );
}

function AdmissionsIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <line x1="19" x2="19" y1="8" y2="14" />
      <line x1="22" x2="16" y1="11" y2="11" />
    </svg>
  );
}

function ResidentsIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function RoomsIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 21h18" />
      <path d="M19 21V5a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v16" />
      <path d="M9 9h1" />
      <path d="M9 13h1" />
      <path d="M9 17h1" />
      <path d="M14 9h1" />
      <path d="M14 13h1" />
      <path d="M14 17h1" />
    </svg>
  );
}

function BedsIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 4v16" />
      <path d="M2 8h18a2 2 0 0 1 2 2v10" />
      <path d="M2 17h20" />
      <path d="M6 8v9" />
    </svg>
  );
}

function PaymentsIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="20" height="14" x="2" y="5" rx="2" />
      <line x1="2" x2="22" y1="10" y2="10" />
      <line x1="6" x2="10" y1="15" y2="15" />
    </svg>
  );
}

function RentBillsIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" x2="8" y1="13" y2="13" />
      <line x1="16" x2="8" y1="17" y2="17" />
      <line x1="10" x2="8" y1="9" y2="9" />
    </svg>
  );
}

function MeterReadingIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

function SecurityDepositsIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function ContractsIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6H8z" />
      <path d="M14 2v6h6" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
      <path d="M10 9H8" />
    </svg>
  );
}

function InspectionsIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="m9 14 2 2 4-4" />
    </svg>
  );
}

function MaintenanceIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

function NoticesIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

function ReportsIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" x2="18" y1="20" y2="10" />
      <line x1="12" x2="12" y1="20" y2="4" />
      <line x1="6" x2="6" y1="20" y2="14" />
    </svg>
  );
}

function SettingsIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function AdminToolsIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
      <path d="M9 12h6M12 9v6" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Grouped Navigation Structure
// ---------------------------------------------------------------------------

type NavItem = {
  name: string;
  href: string;
  permissionId: string;
  icon: (props: { className?: string }) => React.JSX.Element;
};

type NavSection = {
  title: string;
  items: NavItem[];
};

const navSections: NavSection[] = [
  {
    title: "Overview",
    items: [
      { name: "Dashboard", href: "/dashboard", permissionId: "dashboard", icon: DashboardIcon },
    ],
  },
  {
    title: "Residency",
    items: [
      { name: "Admissions", href: "/admissions", permissionId: "admissions", icon: AdmissionsIcon },
      { name: "Residents", href: "/residents", permissionId: "residents", icon: ResidentsIcon },
      { name: "Rooms", href: "/rooms", permissionId: "rooms", icon: RoomsIcon },
      { name: "Beds", href: "/beds", permissionId: "beds", icon: BedsIcon },
    ],
  },
  {
    title: "Finance & Accounts",
    items: [
      { name: "Payments", href: "/payments", permissionId: "payments", icon: PaymentsIcon },
      { name: "Rent Bills", href: "/billing?type=Rent", permissionId: "rent_bills", icon: RentBillsIcon },
      { name: "Meter Reading", href: "/meter-reading", permissionId: "meter_reading", icon: MeterReadingIcon },
      { name: "Security Deposits", href: "/billing?type=Security Deposit", permissionId: "security_deposits", icon: SecurityDepositsIcon },
    ],
  },
  {
    title: "Operations",
    items: [
      { name: "Contracts", href: "/contracts", permissionId: "contracts", icon: ContractsIcon },
      { name: "Inspections", href: "/inspection", permissionId: "inspections", icon: InspectionsIcon },
      { name: "Maintenance", href: "/maintenance", permissionId: "maintenance", icon: MaintenanceIcon },
      { name: "Notices", href: "/notices", permissionId: "notices", icon: NoticesIcon },
      { name: "Reports", href: "/reports", permissionId: "reports", icon: ReportsIcon },
    ],
  },
  {
    title: "System",
    items: [
      { name: "Settings", href: "/settings", permissionId: "settings", icon: SettingsIcon },
    ],
  },
];

function SidebarContent() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [showAdminTools, setShowAdminTools] = useState(false);
  const [allowedPermissionIds, setAllowedPermissionIds] = useState<string[] | null>(null);
  const [isSuper, setIsSuper] = useState(false);
  const [userRole, setUserRole] = useState<string>("Staff");
  const [userEmail, setUserEmail] = useState<string>("");
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    let active = true;

    async function loadAdminAccess() {
      const { data: authData } = await supabase.auth.getUser();
      const email = authData.user?.email;
      if (!email) return;
      if (active) setUserEmail(email);

      const { data } = await supabase
        .from("staff_users")
        .select("role, status, permissions, full_name")
        .eq("email", normalizeIdentityEmail(email))
        .maybeSingle();

      if (!active) return;

      if (data?.role) setUserRole(data.role);

      const superAdminUser = isSuperAdmin(data?.role);
      setIsSuper(superAdminUser);

      const rawPerms = data?.permissions;
      const userPerms: string[] = Array.isArray(rawPerms)
        ? rawPerms
        : typeof rawPerms === "string"
        ? JSON.parse(rawPerms || "[]")
        : [];

      setAllowedPermissionIds(userPerms);

      const canAccessAdmin = superAdminUser || userPerms.includes("admin_tools");
      setShowAdminTools(canAccessAdmin);
    }

    void loadAdminAccess();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!mobileOpen) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMobileOpen(false);
    }

    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [mobileOpen]);

  function isActive(href: string) {
    if (href === "/billing?type=Security Deposit") {
      return pathname === "/billing" && searchParams.get("type") === "Security Deposit";
    }
    if (href === "/billing?type=Rent" || href === "/billing") {
      return pathname === "/billing" && searchParams.get("type") !== "Security Deposit";
    }

    const matchesRoute = pathname === href || pathname.startsWith(`${href}/`);

    if (href === "/payments") {
      return (
        matchesRoute ||
        pathname === "/payment-verification" ||
        pathname.startsWith("/payment-verification/")
      );
    }

    return matchesRoute;
  }

  function isItemVisible(permissionId: string) {
    if (allowedPermissionIds === null) return true;
    if (isSuper) return true;
    return allowedPermissionIds.includes(permissionId);
  }

  const renderedSections = navSections
    .map((section) => {
      const visibleItems = section.items.filter((item) => isItemVisible(item.permissionId));
      return { ...section, items: visibleItems };
    })
    .filter((section) => section.items.length > 0);

  const renderNavList = () => (
    <nav className="space-y-5">
      {renderedSections.map((section) => (
        <div key={section.title} className="space-y-1">
          <p className="px-3 text-[10px] font-bold uppercase tracking-wider text-slate-400/80">
            {section.title}
          </p>
          <div className="space-y-0.5">
            {section.items.map((item) => {
              const active = isActive(item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMobileOpen(false)}
                  className={`group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-150 ${
                    active
                      ? "bg-gradient-to-r from-blue-600 to-indigo-600 text-white font-semibold shadow-md shadow-blue-600/25 ring-1 ring-white/10"
                      : "text-slate-300 hover:bg-slate-800/80 hover:text-white"
                  }`}
                >
                  <Icon
                    className={`h-5 w-5 shrink-0 transition-colors ${
                      active ? "text-white" : "text-slate-400 group-hover:text-slate-200"
                    }`}
                  />
                  <span className="truncate">{item.name}</span>
                  {active && (
                    <span
                      aria-hidden="true"
                      className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-white shadow-xs"
                    />
                  )}
                </Link>
              );
            })}
          </div>
        </div>
      ))}

      {showAdminTools && (
        <div className="space-y-1 pt-1">
          <p className="px-3 text-[10px] font-bold uppercase tracking-wider text-amber-400/80">
            Administration
          </p>
          <Link
            href="/dashboard/settings/data-management"
            onClick={() => setMobileOpen(false)}
            className={`group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-150 ${
              isActive("/dashboard/settings/data-management")
                ? "bg-gradient-to-r from-amber-600 to-orange-600 text-white font-semibold shadow-md shadow-amber-600/25"
                : "text-amber-200/90 hover:bg-slate-800/80 hover:text-amber-100"
            }`}
          >
            <AdminToolsIcon
              className={`h-5 w-5 shrink-0 ${
                isActive("/dashboard/settings/data-management")
                  ? "text-white"
                  : "text-amber-400 group-hover:text-amber-300"
              }`}
            />
            <span className="truncate">Admin Tools</span>
            {isActive("/dashboard/settings/data-management") && (
              <span aria-hidden="true" className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-white" />
            )}
          </Link>
        </div>
      )}
    </nav>
  );

  return (
    <>
      {/* Mobile Sticky Top Header */}
      <div className="sticky top-0 z-40 flex items-center justify-between gap-3 border-b border-slate-800 bg-slate-900/95 px-4 py-3 text-slate-100 shadow-md backdrop-blur-md lg:hidden">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            aria-label="Open navigation menu"
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen(true)}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-700 bg-slate-800/90 text-slate-100 transition hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-400"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <Link href="/dashboard" className="flex min-w-0 items-center gap-2.5">
            <div className="relative shrink-0">
              <img
                src="/logo.jpg"
                alt="Logo"
                className="h-9 w-9 rounded-full bg-white object-cover ring-2 ring-blue-500/30"
              />
            </div>
            <div className="min-w-0 leading-tight">
              <span className="block truncate text-sm font-bold text-white">University Girls</span>
              <span className="block truncate text-xs font-extrabold text-blue-400">Hostel</span>
            </div>
          </Link>
        </div>
        <ProfileDropdown />
      </div>

      {/* Mobile Slide-Over Drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation menu">
          <div
            className="fixed inset-0 bg-slate-950/70 backdrop-blur-xs transition-opacity"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
          <aside className="relative z-10 flex h-full w-72 max-w-[82vw] flex-col bg-slate-900 text-slate-100 shadow-2xl border-r border-slate-800">
            {/* Mobile Drawer Header */}
            <div className="flex items-center justify-between gap-3 border-b border-slate-800 p-5">
              <Link
                href="/dashboard"
                onClick={() => setMobileOpen(false)}
                className="flex min-w-0 items-center gap-3"
              >
                <img
                  src="/logo.jpg"
                  alt="Logo"
                  className="h-10 w-10 shrink-0 rounded-full bg-white object-cover ring-2 ring-blue-500/30 shadow-sm"
                />
                <div className="leading-tight">
                  <span className="block text-sm font-bold text-white">University Girls</span>
                  <span className="block text-sm font-extrabold text-blue-400">Hostel</span>
                </div>
              </Link>
              <button
                type="button"
                aria-label="Close navigation menu"
                onClick={() => setMobileOpen(false)}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-700 bg-slate-800 text-slate-300 transition hover:bg-slate-700 hover:text-white"
              >
                ✕
              </button>
            </div>

            {/* Mobile Drawer Navigation Scrollable Area */}
            <div className="flex-1 overflow-y-auto p-4">{renderNavList()}</div>

            {/* Mobile Drawer Footer */}
            <div className="border-t border-slate-800 p-4 bg-slate-950/60">
              <div className="flex items-center gap-2.5">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                </span>
                <span className="text-xs font-semibold text-slate-300 truncate">{userEmail || "Connected"}</span>
              </div>
            </div>
          </aside>
        </div>
      )}

      {/* Desktop Persistent Sidebar */}
      <aside className="hidden h-screen w-72 shrink-0 flex-col bg-slate-900 border-r border-slate-800/90 text-slate-100 shadow-lg lg:sticky lg:top-0 lg:flex">
        {/* Brand Header */}
        <div className="p-5 border-b border-slate-800/80 bg-slate-900/60">
          <Link
            href="/dashboard"
            className="group flex items-center gap-3.5 focus:outline-none"
          >
            <div className="relative shrink-0">
              <img
                src="/logo.jpg"
                alt="University Girls Hostel Logo"
                className="h-11 w-11 rounded-full bg-white object-cover ring-2 ring-blue-500/30 shadow-md group-hover:ring-blue-400 transition-all duration-200"
              />
              <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-emerald-500 ring-2 ring-slate-900" />
            </div>
            <div className="min-w-0">
              <h1 className="text-base font-bold text-white tracking-tight leading-tight group-hover:text-blue-200 transition-colors">
                University Girls
              </h1>
              <span className="text-sm font-extrabold text-blue-400 tracking-tight leading-none block">
                Hostel
              </span>
              <span className="mt-1 inline-flex items-center rounded-md bg-blue-950/90 border border-blue-800/60 px-2 py-0.5 text-[9px] font-bold text-blue-300 uppercase tracking-wider">
                Portal Management
              </span>
            </div>
          </Link>
        </div>

        {/* Scrollable Navigation Menu */}
        <div className="flex-1 overflow-y-auto px-3.5 py-4 scrollbar-thin scrollbar-thumb-slate-800 scrollbar-track-transparent hover:scrollbar-thumb-slate-700">
          {renderNavList()}
        </div>

        {/* Bottom User / Status Bar */}
        <div className="border-t border-slate-800/80 p-3.5 bg-slate-950/60">
          <div className="flex items-center justify-between rounded-xl bg-slate-800/60 p-2.5 border border-slate-700/50">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-600/20 text-blue-400 font-bold text-xs ring-1 ring-blue-500/30">
                {userRole.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 leading-tight">
                <p className="text-xs font-semibold text-white truncate capitalize">{userRole}</p>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  <span className="text-[10px] text-slate-400 font-medium">Online</span>
                </div>
              </div>
            </div>
            <Link
              href="/settings"
              title="Settings"
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-700/60 hover:text-white transition"
            >
              <SettingsIcon className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </aside>
    </>
  );
}

export default function Sidebar() {
  return (
    <Suspense
      fallback={
        <>
          <div className="h-16 w-full bg-slate-900 lg:hidden" />
          <aside className="hidden h-screen w-72 shrink-0 flex-col bg-slate-900 p-5 text-slate-100 lg:flex border-r border-slate-800" />
        </>
      }
    >
      <SidebarContent />
    </Suspense>
  );
}
