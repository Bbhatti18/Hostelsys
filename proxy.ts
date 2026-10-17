import { normalizeIdentityEmail } from "@/lib/identity";
import { NextResponse, type NextRequest } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "dummy-key";
const COOKIE_CHUNK_SIZE = 3000;
const MAX_COOKIE_CHUNKS = 12;

const adminRoutes = [
  "/dashboard",
  "/residents",
  "/rooms",
  "/beds",
  "/admissions",
  "/contracts",
  "/contract-template",
  "/billing",
  "/meter-reading",
  "/payments",
  "/payment-verification",
  "/inspection",
  "/maintenance",
  "/notices",
  "/reports",
  "/settings",
  "/users",
  "/profile",
];

const residentPortalPath = "/resident-portal";
const residentPortalDataPath = "/api/resident-portal/data";
const residentPasswordSetupPath = "/resident-portal/change-password";
const adminPasswordSetupPath = "/admin123/change-password";
const loginPath = "/login";

// API routes that verify a bearer token and the caller's staff role themselves,
// so they must not be redirected to /login when cookies are absent.
const selfAuthenticatedApiPaths = new Set([
  residentPortalDataPath,
  "/api/payment-evidence",
  "/api/resident-portal/profile",
  "/api/resident-portal/profile/documents",
  "/api/billing/bulk-generate",
  "/api/billing/approve",
  // Both verify a staff bearer token, an active staff_users row and an
  // allowed role before doing anything; without this they answered a
  // cookie-less POST with a 307 to /login, which surfaces as a 405.
  "/api/residents/create-login",
  "/api/residents/create-login/reset-password",
  "/api/meter-reading",
  "/api/meter-reading/config",
  "/api/maintenance/notify-completed",
  "/api/admissions/update",
]);

function isAdminRoute(pathname: string) {
  return adminRoutes.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

function isResidentPortalRoute(pathname: string) {
  return pathname === residentPortalPath || pathname.startsWith(`${residentPortalPath}/`);
}

function createCookieStorage(request: NextRequest, response: NextResponse) {
  return {
    getItem(key: string) {
      const legacyValue = request.cookies.get(key)?.value;
      if (legacyValue) return decodeURIComponent(legacyValue);

      let combined = "";
      for (let index = 0; index < MAX_COOKIE_CHUNKS; index += 1) {
        const chunk = request.cookies.get(`${key}.${index}`)?.value;
        if (!chunk) break;
        combined += chunk;
      }

      return combined ? decodeURIComponent(combined) : null;
    },
    setItem(key: string, value: string) {
      response.cookies.delete(key);
      for (let index = 0; index < MAX_COOKIE_CHUNKS; index += 1) response.cookies.delete(`${key}.${index}`);
      const encoded = encodeURIComponent(value);
      const chunks = encoded.match(new RegExp(`.{1,${COOKIE_CHUNK_SIZE}}`, "g")) ?? [];
      chunks.forEach((chunk, index) => response.cookies.set(`${key}.${index}`, chunk, { httpOnly: false, sameSite: "lax", path: "/", secure: process.env.NODE_ENV === "production", maxAge: 31536000 }));
    },
    removeItem(key: string) {
      response.cookies.delete(key);
      for (let index = 0; index < MAX_COOKIE_CHUNKS; index += 1) response.cookies.delete(`${key}.${index}`);
    },
  };
}

function createServerClient(request: NextRequest, response: NextResponse) {
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storage: createCookieStorage(request, response),
      storageKey: "sb-auth-token",
    },
  });
}

async function getUserRole(
  supabase: SupabaseClient,
  user: { email?: string; user_metadata?: Record<string, any> } | null | undefined
) {
  if (!user?.email) {
    return null;
  }

  const normalizedEmail = user.email.toLowerCase();

  const { data: staffUser } = await supabase
    .from("staff_users")
    .select("email, role")
    .eq("email", normalizeIdentityEmail(normalizedEmail))
    .maybeSingle();

  if (staffUser?.email) {
    return "staff" as const;
  }

  const { data: residentUser } = await supabase
    .from("residents")
    .select("id, email, status")
    .eq("email", normalizeIdentityEmail(normalizedEmail))
    .maybeSingle();

  if (residentUser?.email && String(residentUser.status ?? "").trim().toLowerCase() !== "archived") {
    return "resident" as const;
  }

  const metadataResidentId =
    typeof user.user_metadata?.resident_id === "string" ? user.user_metadata.resident_id.trim() : "";

  if (metadataResidentId) {
    const { data: residentById } = await supabase
      .from("residents")
      .select("id, email, status")
      .eq("id", metadataResidentId)
      .maybeSingle();

    if (residentById?.id && String(residentById.status ?? "").trim().toLowerCase() !== "archived") {
      return "resident" as const;
    }
  }

  return null;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const response = NextResponse.next();

  if (
    pathname === loginPath ||
    pathname === "/admin123" ||
    pathname === residentPasswordSetupPath ||
    pathname === adminPasswordSetupPath ||
    pathname === "/auth/callback" ||
    pathname === "/reset-password" ||
    pathname === "/change-password" ||
    pathname === "/forgot-password" ||
    pathname === "/resident-login" ||
    pathname.startsWith("/api/resident-portal/") ||
    selfAuthenticatedApiPaths.has(pathname)
  ) {
    return response;
  }

  const supabase = createServerClient(request, response);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) {
    return NextResponse.redirect(new URL(loginPath, request.url));
  }

  const role = await getUserRole(supabase, user);

  if (isAdminRoute(pathname)) {
    if (role === "staff") {
      return response;
    }

    if (role === "resident") {
      return NextResponse.redirect(new URL(residentPortalPath, request.url));
    }

    return NextResponse.redirect(new URL("/admin123", request.url));
  }

  if (isResidentPortalRoute(pathname)) {
    if (role === "resident" || role === "staff") {
      return response;
    }

    return NextResponse.redirect(new URL(loginPath, request.url));
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|txt|json|xml)$).*)",
  ],
};
