"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { resolveAuthenticatedResident, type AuthenticatedResident } from "@/lib/residentPortalAuth";

type NavItem = {
  href: string;
  label: string;
  badge?: string;
  icon: (props: { className?: string }) => React.JSX.Element;
  exact?: boolean;
};

type NavSection = {
  title: string;
  items: NavItem[];
};

export default function ResidentSidebar() {
  return (
    <Suspense
      fallback={
        <>
          <div className="h-16 w-full bg-slate-900 lg:hidden" />
          <aside className="hidden h-screen w-72 shrink-0 flex-col bg-slate-900 p-5 text-slate-100 lg:flex border-r border-slate-800" />
        </>
      }
    >
      <ResidentSidebarContent />
    </Suspense>
  );
}

function ResidentSidebarContent() {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [resident, setResident] = useState<AuthenticatedResident | null>(null);
  const [loadingUser, setLoadingUser] = useState(true);

  const fetchResidentInfo = useCallback(async () => {
    try {
      const auth = await resolveAuthenticatedResident();
      if (auth.resident) {
        setResident(auth.resident);
      }
    } catch {
      // Ignore background error
    } finally {
      setLoadingUser(false);
    }
  }, []);

  useEffect(() => {
    void fetchResidentInfo();
  }, [fetchResidentInfo]);

  async function handleLogout() {
    try {
      await supabase.auth.signOut();
    } finally {
      router.replace("/login");
    }
  }

  const navSections: NavSection[] = [
    {
      title: "Overview",
      items: [
        {
          href: "/resident-portal",
          label: "Dashboard",
          icon: OverviewIcon,
          exact: true,
        },
      ],
    },
    {
      title: "Finances",
      items: [
        {
          href: "/resident-portal/bills",
          label: "Bills & Fines",
          icon: BillsIcon,
        },
        {
          href: "/resident-portal/payments",
          label: "Payments & Receipts",
          icon: PaymentsIcon,
        },
      ],
    },
    {
      title: "Accommodation",
      items: [
        {
          href: "/resident-portal/room",
          label: "My Room & Bed",
          icon: RoomIcon,
        },
        {
          href: "/resident-portal/contract",
          label: "Contract Agreement",
          icon: ContractIcon,
        },
      ],
    },
    {
      title: "Services & Alerts",
      items: [
        {
          href: "/resident-portal/maintenance",
          label: "Maintenance Requests",
          icon: MaintenanceIcon,
        },
        {
          href: "/resident-portal/inspections",
          label: "Room Inspections",
          icon: InspectionIcon,
        },
        {
          href: "/resident-portal/notices",
          label: "Notices & Updates",
          icon: NoticesIcon,
        },
      ],
    },
    {
      title: "Account",
      items: [
        {
          href: "/resident-portal/profile",
          label: "My Profile",
          icon: ProfileIcon,
        },
        {
          href: "/resident-portal/change-password",
          label: "Change Password",
          icon: SecurityIcon,
        },
      ],
    },
  ];

  function isItemActive(item: NavItem) {
    if (item.exact) {
      return pathname === item.href;
    }
    return pathname === item.href || pathname.startsWith(`${item.href}/`);
  }

  function renderNavList() {
    return (
      <div className="space-y-6">
        {navSections.map((section) => (
          <div key={section.title}>
            <div className="px-3 pb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400/80">
              {section.title}
            </div>
            <nav className="space-y-1">
              {section.items.map((item) => {
                const active = isItemActive(item);
                const Icon = item.icon;

                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMobileOpen(false)}
                    className={`group flex items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-150 ${
                      active
                        ? "bg-gradient-to-r from-indigo-600 to-violet-600 text-white font-semibold shadow-md shadow-indigo-950/40"
                        : "text-slate-300 hover:bg-slate-800/80 hover:text-white"
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Icon
                        className={`h-5 w-5 shrink-0 transition-colors ${
                          active
                            ? "text-white"
                            : "text-slate-400 group-hover:text-indigo-300"
                        }`}
                      />
                      <span className="truncate">{item.label}</span>
                    </div>

                    {active ? (
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-white shadow-xs" />
                    ) : item.badge ? (
                      <span className="rounded-md bg-indigo-900/60 border border-indigo-700/50 px-1.5 py-0.5 text-[10px] font-bold text-indigo-200">
                        {item.badge}
                      </span>
                    ) : null}
                  </Link>
                );
              })}
            </nav>
          </div>
        ))}
      </div>
    );
  }

  const residentInitial = resident?.full_name?.trim()?.charAt(0)?.toUpperCase() || "R";
  const residentDisplayName = resident?.full_name || "Resident";

  return (
    <>
      {/* Mobile Top Navigation Bar */}
      <div className="flex h-16 w-full items-center justify-between border-b border-slate-800 bg-slate-900 px-4 text-white lg:hidden">
        <Link
          href="/resident-portal"
          className="flex items-center gap-2.5 min-w-0"
          onClick={() => setMobileOpen(false)}
        >
          <img
            src="/logo.jpg"
            alt="University Girls Hostel Logo"
            className="h-9 w-9 shrink-0 rounded-full bg-white object-cover ring-2 ring-indigo-500/40"
          />
          <div className="leading-tight truncate">
            <span className="block text-xs font-bold text-white truncate">University Girls Hostel</span>
            <span className="block text-[11px] font-extrabold text-indigo-400">Resident Portal</span>
          </div>
        </Link>
        <button
          type="button"
          aria-label="Open resident navigation menu"
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen(true)}
          className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700 transition"
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="4" x2="20" y1="6" y2="6" />
            <line x1="4" x2="20" y1="12" y2="12" />
            <line x1="4" x2="20" y1="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Mobile Drawer Overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div
            className="fixed inset-0 bg-slate-950/70 backdrop-blur-xs transition-opacity"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
          <aside className="relative z-10 flex h-full w-72 max-w-[84vw] flex-col bg-slate-900 text-slate-100 shadow-2xl border-r border-slate-800">
            {/* Mobile Drawer Header */}
            <div className="flex items-center justify-between gap-3 border-b border-slate-800 p-4">
              <Link
                href="/resident-portal"
                onClick={() => setMobileOpen(false)}
                className="flex min-w-0 items-center gap-3"
              >
                <img
                  src="/logo.jpg"
                  alt="Logo"
                  className="h-10 w-10 shrink-0 rounded-full bg-white object-cover ring-2 ring-indigo-500/40 shadow-sm"
                />
                <div className="leading-tight">
                  <span className="block text-sm font-bold text-white">University Girls</span>
                  <span className="block text-sm font-extrabold text-indigo-400">Resident Portal</span>
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
            <div className="border-t border-slate-800 p-4 bg-slate-950/70">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-600/30 text-indigo-300 font-bold text-xs ring-1 ring-indigo-500/40">
                    {residentInitial}
                  </div>
                  <div className="min-w-0 leading-tight">
                    <p className="text-xs font-semibold text-white truncate">{residentDisplayName}</p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                      <span className="text-[10px] text-slate-400">Resident</span>
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleLogout}
                  title="Logout"
                  className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-red-400 transition"
                >
                  <LogoutIcon className="h-4 w-4" />
                </button>
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
            href="/resident-portal"
            className="group flex items-center gap-3.5 focus:outline-none"
          >
            <div className="relative shrink-0">
              <img
                src="/logo.jpg"
                alt="University Girls Hostel Logo"
                className="h-11 w-11 rounded-full bg-white object-cover ring-2 ring-indigo-500/40 shadow-md group-hover:ring-indigo-400 transition-all duration-200"
              />
              <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-emerald-500 ring-2 ring-slate-900" />
            </div>
            <div className="min-w-0">
              <h1 className="text-base font-bold text-white tracking-tight leading-tight group-hover:text-indigo-200 transition-colors">
                University Girls
              </h1>
              <span className="text-sm font-extrabold text-indigo-400 tracking-tight leading-none block">
                Hostel
              </span>
              <span className="mt-1 inline-flex items-center rounded-md bg-indigo-950/90 border border-indigo-800/60 px-2 py-0.5 text-[9px] font-bold text-indigo-300 uppercase tracking-wider">
                Resident Portal
              </span>
            </div>
          </Link>
        </div>

        {/* Scrollable Navigation Menu */}
        <div className="flex-1 overflow-y-auto px-3.5 py-4 scrollbar-thin scrollbar-thumb-slate-800 scrollbar-track-transparent hover:scrollbar-thumb-slate-700">
          {renderNavList()}
        </div>

        {/* Bottom User / Resident Profile & Logout */}
        <div className="border-t border-slate-800/80 p-3.5 bg-slate-950/60">
          <div className="flex items-center justify-between rounded-xl bg-slate-800/60 p-2.5 border border-slate-700/50">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-600/30 text-indigo-300 font-bold text-xs ring-1 ring-indigo-500/40">
                {residentInitial}
              </div>
              <div className="min-w-0 leading-tight">
                <p className="text-xs font-semibold text-white truncate">{residentDisplayName}</p>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  <span className="text-[10px] text-slate-400 font-medium">Resident Online</span>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={handleLogout}
              title="Logout from Resident Portal"
              className="rounded-lg p-2 text-slate-400 hover:bg-red-950/40 hover:text-red-400 transition"
            >
              <LogoutIcon className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

/* =========================================================================
   SVG Navigation Icons
   ========================================================================= */

function OverviewIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="7" height="9" x="3" y="3" rx="1.5" />
      <rect width="7" height="5" x="14" y="3" rx="1.5" />
      <rect width="7" height="9" x="14" y="12" rx="1.5" />
      <rect width="7" height="5" x="3" y="16" rx="1.5" />
    </svg>
  );
}

function BillsIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}

function PaymentsIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="20" height="14" x="2" y="5" rx="2" />
      <line x1="2" x2="22" y1="10" y2="10" />
      <circle cx="7" cy="15" r="1" />
      <circle cx="11" cy="15" r="1" />
    </svg>
  );
}

function RoomIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 4v16" />
      <path d="M2 8h18a2 2 0 0 1 2 2v10" />
      <path d="M2 17h20" />
      <path d="M6 8v9" />
    </svg>
  );
}

function ContractIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <rect width="8" height="4" x="8" y="2" rx="1" />
      <path d="m9 14 2 2 4-4" />
    </svg>
  );
}

function MaintenanceIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

function InspectionIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <rect width="8" height="4" x="8" y="2" rx="1" />
      <circle cx="12" cy="13" r="2.5" />
      <path d="m14 15 2 2" />
    </svg>
  );
}

function NoticesIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m3 11 18-5v12L3 14v-3z" />
      <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
    </svg>
  );
}

function ProfileIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

function SecurityIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function LogoutIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}
