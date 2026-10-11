import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
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

function serverErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback;
}

function normalized(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

export async function POST(request: NextRequest) {
  try {
    console.info("[resident-login:diagnostic] Authorization header present.", {
      present: request.headers.has("authorization"),
    });
    const token = bearerToken(request);
    if (!token) {
      return NextResponse.json(
        { error: "Your admin session could not be verified." },
        { status: 401 },
      );
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      console.info("[resident-login:diagnostic] Supabase admin client initialized.", {
        initialized: false,
      });
    }
    if (!supabaseUrl) return jsonError("NEXT_PUBLIC_SUPABASE_URL is not configured on the server.", 500);
    if (!anonKey) return jsonError("NEXT_PUBLIC_SUPABASE_ANON_KEY is not configured on the server.", 500);
    if (!serviceRoleKey) return jsonError("SUPABASE_SERVICE_ROLE_KEY is not configured on the server.", 500);

    const authClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
    console.info("[resident-login:diagnostic] Supabase admin client initialized.", {
      initialized: true,
    });

    const { data: authData, error: authError } =
      await authClient.auth.getUser(token);
    const staffEmail = authData.user?.email?.trim().toLowerCase();
    console.info("[resident-login:diagnostic] getUser completed.", {
      success: !authError && Boolean(staffEmail),
      failure: authError ? "supabase_get_user_failed" : !staffEmail ? "authenticated_user_email_missing" : null,
    });

    if (authError || !staffEmail) {
      return jsonError(
        authError?.message || "Your admin session could not be verified.",
        401,
      );
    }

    const { data: staffRows, error: staffError } = await supabaseAdmin
      .from("staff_users")
      .select("id, email, role, status");
    const matchingStaff = (staffRows ?? []).filter(
      (staffRecord) => normalized(staffRecord.email) === staffEmail,
    );
    const staffUser = matchingStaff.length === 1 ? matchingStaff[0] : null;
    console.log({
      staffFound: Boolean(staffUser),
      queryError: staffError?.message,
    });
    console.info("[resident-login:diagnostic] Staff lookup completed.", {
      email: staffEmail,
      found: Boolean(staffUser),
    });

    const staffRole = normalized(staffUser?.role);
    const staffStatus = normalized(staffUser?.status);

    if (
      staffError ||
      !staffUser ||
      staffStatus !== "active" ||
      !ALLOWED_STAFF_ROLES.has(staffRole)
    ) {
      const forbiddenReason = staffError
        ? "staff_lookup_failed"
        : matchingStaff.length > 1
          ? "multiple_staff_users_match"
        : !staffUser
          ? "staff_user_not_found"
          : staffStatus !== "active"
            ? "staff_user_not_active"
            : "staff_role_not_allowed";
      console.warn("[resident-login:diagnostic] Returning 403.", {
        email: staffEmail,
        reason: forbiddenReason,
      });
      return jsonError(
        staffError?.message || "You do not have permission to create resident logins.",
        403,
      );
    }

    const body = (await request.json().catch(() => null)) as
      | { residentId?: unknown }
      | null;
    const residentId =
      typeof body?.residentId === "string" ? body.residentId.trim() : "";

    if (!residentId) {
      return NextResponse.json(
        { error: "A valid resident is required." },
        { status: 400 },
      );
    }

    const { data: resident, error: residentError } = await supabaseAdmin
      .from("residents")
      .select("id, full_name, email, status")
      .eq("id", residentId)
      .maybeSingle();

    if (residentError || !resident) {
      return jsonError(
        residentError
          ? `The resident profile could not be verified: ${residentError.message}`
          : "The resident profile could not be found.",
        residentError ? 500 : 404,
      );
    }

    if (String(resident.status ?? "").trim().toLowerCase() === "archived") {
      return NextResponse.json(
        { error: "Archived residents cannot receive a new portal login." },
        { status: 400 },
      );
    }

    const email = String(resident.email ?? "").trim().toLowerCase();
    if (!email) {
      return NextResponse.json(
        { error: "The resident must have an email address before a login can be created." },
        { status: 400 },
      );
    }

    let page = 1;
    let existingUser = null as {
      id: string;
      email?: string;
      user_metadata?: Record<string, any>;
    } | null;

    while (page <= 20 && !existingUser) {
      const { data: usersData, error: usersError } =
        await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });

      if (usersError) {
        console.error("[resident-login] Supabase Auth users could not be listed.", usersError);
        return jsonError(`Existing portal accounts could not be checked: ${usersError.message}`, 500);
      }

      existingUser =
        usersData.users.find(
          (user) => user.email?.trim().toLowerCase() === email,
        ) ?? null;

      if (usersData.users.length < 1000) break;
      page += 1;
    }

    const temporaryPassword = createTemporaryPassword();

    if (existingUser) {
      const { data: updatedUser, error: updateError } =
        await supabaseAdmin.auth.admin.updateUserById(existingUser.id, {
          password: temporaryPassword,
          user_metadata: {
            ...existingUser.user_metadata,
            resident_id: resident.id,
            full_name: resident.full_name,
            account_type: "resident",
            must_change_password: true,
          },
        });

      if (updateError || !updatedUser.user) {
        return jsonError(
          `Existing portal account could not be updated: ${updateError?.message || "Update failed"}`,
          500,
        );
      }

      const emailDispatch = await sendResidentCredentialsEmail({
        residentName: String(resident.full_name ?? "Resident"),
        email,
        temporaryPassword,
        portalLoginUrl: portalLoginUrl(request),
        isReset: true,
      });

      return NextResponse.json({
        created: true,
        email,
        temporaryPassword,
        emailSent: emailDispatch.sent,
        emailProvider: emailDispatch.provider,
        emailError: emailDispatch.error,
      });
    }

    const { data: createdUser, error: createError } =
      await supabaseAdmin.auth.admin.createUser({
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

    if (createError || !createdUser.user) {
      const message = createError?.message?.toLowerCase() ?? "";
      if (message.includes("already") || message.includes("registered")) {
        const { data: listData } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
        const match = listData?.users.find((u) => u.email?.trim().toLowerCase() === email);
        if (match) {
          await supabaseAdmin.auth.admin.updateUserById(match.id, {
            password: temporaryPassword,
            user_metadata: {
              ...match.user_metadata,
              resident_id: resident.id,
              full_name: resident.full_name,
              account_type: "resident",
              must_change_password: true,
            },
          });
          const emailDispatch = await sendResidentCredentialsEmail({
            residentName: String(resident.full_name ?? "Resident"),
            email,
            temporaryPassword,
            portalLoginUrl: portalLoginUrl(request),
            isReset: true,
          });
          return NextResponse.json({
            created: true,
            email,
            temporaryPassword,
            emailSent: emailDispatch.sent,
            emailProvider: emailDispatch.provider,
            emailError: emailDispatch.error,
          });
        }
      }

      console.error("[resident-login] Supabase Auth account creation failed.", createError);
      return jsonError(
        `Supabase Auth could not create the resident portal account: ${createError?.message || "No auth user was returned."}`,
        500,
      );
    }

    const emailDispatch = await sendResidentCredentialsEmail({
      residentName: String(resident.full_name ?? "Resident"),
      email,
      temporaryPassword,
      portalLoginUrl: portalLoginUrl(request),
    });

    return NextResponse.json({
      created: true,
      email,
      temporaryPassword,
      emailSent: emailDispatch.sent,
      emailProvider: emailDispatch.provider,
      emailError: emailDispatch.error,
    });
  } catch (error) {
    console.error("[resident-login] Unexpected portal account creation failure.", error);
    return jsonError(
      `Unable to create the resident portal login: ${serverErrorMessage(error, "Unexpected server error.")}`,
      500,
    );
  }
}
