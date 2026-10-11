"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function NotFound() {
  const router = useRouter();

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Defensive check: If the user hit a 404 URL with auth tokens in the hash (e.g. Supabase recovery or PKCE),
    // redirect them to the auth callback handler so they don't get stranded.
    const hash = window.location.hash || "";
    const search = window.location.search || "";

    if (
      hash.includes("access_token=") ||
      hash.includes("type=recovery") ||
      search.includes("code=") ||
      search.includes("token_hash=")
    ) {
      router.replace(`/auth/callback${search}${hash}`);
    }
  }, [router]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-slate-100 p-4 text-center">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl sm:p-8">
        <div className="flex flex-col items-center justify-center mb-6">
          <img
            src="/logo.jpg"
            alt="University Girls Hostel"
            className="h-24 w-24 rounded-full object-cover shadow-sm mb-4"
          />
          <span className="rounded-full bg-blue-100 px-3 py-1 text-xs font-semibold text-blue-700">
            Error 404
          </span>
          <h1 className="mt-3 text-2xl font-bold text-slate-800 sm:text-3xl">
            Page Not Found
          </h1>
          <p className="mt-2 text-sm text-slate-500">
            The page you are looking for doesn&apos;t exist, was moved, or requires signing in first.
          </p>
        </div>

        <div className="mt-6 flex flex-col gap-3">
          <Link
            href="/resident-portal"
            className="w-full rounded-lg bg-blue-600 px-4 py-3 text-center text-sm font-medium text-white hover:bg-blue-700 transition-colors shadow-sm"
          >
            Go to Resident Portal
          </Link>
          <Link
            href="/login"
            className="w-full rounded-lg border border-slate-300 bg-white px-4 py-3 text-center text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
          >
            Resident Login
          </Link>
          <Link
            href="/admin123"
            className="text-xs text-slate-400 hover:text-slate-600 hover:underline pt-2"
          >
            Staff / Admin Sign In
          </Link>
        </div>
      </div>
    </main>
  );
}
