import { normalizeIdentityEmail } from "@/lib/identity";
import { NextRequest, NextResponse } from "next/server";
import { createClient, type User } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { sendResidentCredentialsEmail } from "@/lib/email/residentCredentialsEmail";

const ALLOWED_STAFF_ROLES = new Set([
  "super admin",
  "admin",
  "manager",
  "reception",
]);

function portalLoginUrl(request: NextRequest) {
  const configured = String(
    process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_APP_URL || "",
  )
    .trim()
    .replace(/\/$/, "");
  if (configured) return `${configured}/login`;
  try {
    return `${new URL(request.url).origin}/login`;
  } catch {
    return "http://localhost:3000/login";
  }
}

function createTemporaryPassword() {
  const alphabet =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const random = new Uint32Array(14);
  crypto.getRandomValues(random);
  const body = Array.from(random, (value) => alphabet[value % alphabet.length]).join(
    "",
  );
  return `Hms@${body}`;
}

function bearerToken(request: NextRequest) {
  const header = request.headers.get("authorization") ?? "";
  return header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";
}

function jsonError(error: string, status: number) {
  return NextResponse.json(
    { error },
    { status, headers: { "Cache-Control": "private, no-store" } },
  );
}

async function findAuthUsersByEmail(email: string) {
  const matches: User[] = [];

  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({
      page,
      perPage: 1000,
    });

    if (error) return { matches: [], error };

    matches.push(
      ...data.users.filter(
        (user) => user.email?.trim().toLowerCase() === email,
      ),
    );

    if (data.users.length < 1000) break;
  }

  return { matches, error: null };
}

export async function POST(request: NextRequest) {
  try {
    const token = bearerToken(request);
    if (!token) {
      return jsonError("Your admin session could not be verified.", 401);
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) {
      return jsonError("Supabase server configuration is incomplete.", 500);
    }

    const authClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } =
      await authClient.auth.getUser(token);
    const staffEmail = authData.user?.email?.trim().toLowerCase() ?? "";

    if (authError || !staffEmail) {
      return jsonError("Your admin session could not be verified.", 401);
    }

    const { data: staff, error: staffError } = await supabaseAdmin
      .from("staff_users")
      .select("id, email, role, status")
      .eq("email", normalizeIdentityEmail(staffEmail))
      .maybeSingle();
    const staffRole = String(staff?.role ?? "").trim().toLowerCase();
    const staffStatus = String(staff?.status ?? "").trim().toLowerCase();

    if (
      staffError ||
      !staff ||
      staffStatus !== "active" ||
      !ALLOWED_STAFF_ROLES.has(staffRole)
    ) {
      return jsonError(
        "You do not have permission to reset resident portal passwords.",
        403,
      );
    }

    const body = (await request.json().catch(() => null)) as
      | { residentId?: unknown }
      | null;
    const residentId =
      typeof body?.residentId === "string" ? body.residentId.trim() : "";
    if (!residentId) {
      return jsonError("A valid resident is required.", 400);
    }

    const { data: resident, error: residentError } = await supabaseAdmin
      .from("residents")
      .select("id, full_name, email, status")
      .eq("id", residentId)
      .maybeSingle();

    if (residentError || !resident) {
      return jsonError("The resident profile could not be verified.", 404);
    }
    if (String(resident.status ?? "").trim().toLowerCase() === "archived") {
      return jsonError("Archived residents cannot receive a new portal password.", 400);
    }

    const email = String(resident.email ?? "").trim().toLowerCase();
    if (!email) {
      return jsonError(
        "The resident must have an email address before a password can be reset.",
        400,
      );
    }

    const { matches, error: usersError } = await findAuthUsersByEmail(email);
    if (usersError) {
      return jsonError("The resident portal account could not be checked.", 500);
    }
    const temporaryPassword = createTemporaryPassword();
    let authUser = matches[0] ?? null;

    if (!authUser) {
      const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
        email,
        password: temporaryPassword,
        email_confirm: true,
        user_metadata: {
          resident_id: resident.id,
          full_name: resident.full_name,
          account_type: "resident",
          must_change_password: true,
        },
      });

      if (createError || !created.user) {
        return jsonError(
          `Unable to create a portal account for this resident: ${createError?.message || "Creation failed"}`,
          500,
        );
      }
      authUser = created.user;
    } else {
      if (matches.length > 1) {
        return jsonError(
          "Multiple portal accounts match this resident email. Resolve the account conflict before resetting the password.",
          409,
        );
      }

      const linkedResidentId =
        typeof authUser.user_metadata?.resident_id === "string"
          ? authUser.user_metadata.resident_id.trim()
          : "";
      const accountType = String(
        authUser.user_metadata?.account_type ?? "",
      ).trim().toLowerCase();

      if (accountType && accountType !== "resident") {
        return jsonError(
          "The matching auth account belongs to a different account type and cannot be relinked automatically.",
          409,
        );
      }

      if (linkedResidentId !== resident.id || accountType !== "resident") {
        const { error: mappingError } =
          await supabaseAdmin.auth.admin.updateUserById(authUser.id, {
            user_metadata: {
              ...authUser.user_metadata,
              resident_id: resident.id,
              full_name: resident.full_name,
              account_type: "resident",
            },
          });

        if (mappingError) {
          return jsonError(
            "The resident portal account mapping could not be repaired.",
            500,
          );
        }
      }

      const { data: updatedUser, error: updateError } =
        await supabaseAdmin.auth.admin.updateUserById(authUser.id, {
          password: temporaryPassword,
        });

      if (updateError || !updatedUser.user) {
        return jsonError("The resident portal password could not be reset.", 500);
      }
    }

    const emailDispatch = await sendResidentCredentialsEmail({
      residentName: String(resident.full_name ?? "Resident"),
      email,
      temporaryPassword,
      portalLoginUrl: portalLoginUrl(request),
      isReset: true,
    });

    return NextResponse.json(
      {
        email,
        temporaryPassword,
        emailSent: emailDispatch.sent,
        emailProvider: emailDispatch.provider,
        emailError: emailDispatch.error,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    return jsonError("Unable to reset the resident portal password.", 500);
  }
}
