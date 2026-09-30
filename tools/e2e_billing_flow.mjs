#!/usr/bin/env node
/**
 * End-to-end verification for the resident -> admission -> contract -> billing
 * -> approval -> resident-portal dataflow.
 *
 * It creates clearly marked test data, asserts the invariants each step of the
 * flow depends on, and removes everything it created before exiting.
 *
 * Usage:
 *   node tools/e2e_billing_flow.mjs
 *
 * Environment (read from .env.local when present; values are never printed):
 *   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
 *   SUPABASE_SERVICE_ROLE_KEY   - required
 *   E2E_BASE_URL                - default http://localhost:3000
 *   E2E_STAFF_EMAIL / E2E_STAFF_PASSWORD
 *       Credentials of a staff_users account. Required for the HTTP phases
 *       (create-login, bulk generate, approve). Without them the script runs
 *       the database-level phases only and reports the rest as skipped.
 */

import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

const TAG = `E2E-${Date.now()}`;
const results = [];
const cleanup = [];

function loadEnvLine(line) {
  const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (!match) return;
  const [, key, rawValue] = match;
  if (process.env[key]) return;
  let value = rawValue.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  process.env[key] = value;
}

async function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    try {
      const contents = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
      contents.split(/\r?\n/).forEach(loadEnvLine);
    } catch {
      /* file is optional */
    }
  }
}

function record(name, status, detail = "") {
  results.push({ name, status, detail });
  const icon = status === "pass" ? "PASS" : status === "skip" ? "SKIP" : "FAIL";
  console.log(`[${icon}] ${name}${detail ? ` - ${detail}` : ""}`);
}

function check(name, condition, detail = "") {
  record(name, condition ? "pass" : "fail", detail);
  return Boolean(condition);
}

function fail(name, error) {
  record(name, "fail", error instanceof Error ? error.message : String(error));
}

function addDays(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function billingMonth() {
  return new Date().toISOString().slice(0, 7);
}

async function main() {
  await loadEnv();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const baseUrl = (process.env.E2E_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
  const staffEmail = process.env.E2E_STAFF_EMAIL || "";
  const staffPassword = process.env.E2E_STAFF_PASSWORD || "";

  if (!url || !anonKey || !serviceKey) {
    console.error(
      "Missing Supabase configuration. Set NEXT_PUBLIC_SUPABASE_URL, " +
        "NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY.",
    );
    process.exit(2);
  }

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const post = async (path, body, token) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body ?? {}),
    });
    const payload = await response.json().catch(() => null);
    return { status: response.status, payload };
  };

  const get = async (path, token) => {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const payload = await response.json().catch(() => null);
    return { status: response.status, payload };
  };

  // --- staff session (optional) -------------------------------------------
  let staffToken = "";
  if (staffEmail && staffPassword) {
    const staffAuth = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await staffAuth.auth.signInWithPassword({
      email: staffEmail,
      password: staffPassword,
    });
    if (error || !data.session) {
      record("Staff sign-in", "fail", error?.message ?? "no session returned");
    } else {
      staffToken = data.session.access_token;
      record("Staff sign-in", "pass", staffEmail);
    }
  } else {
    record(
      "Staff sign-in",
      "skip",
      "set E2E_STAFF_EMAIL / E2E_STAFF_PASSWORD to run the HTTP phases",
    );
  }

  let residentId = "";
  let residentEmail = "";
  let temporaryPassword = "";
  let admissionId = "";
  let bedId = "";
  let previousBedStatus = "";
  let residentToken = "";
  let generatedBillId = "";

  try {
    // === Phase 1: resident creation ======================================
    residentEmail = `e2e.resident.${Date.now()}@example.test`;
    const { data: resident, error: residentError } = await admin
      .from("residents")
      .insert({
        full_name: `${TAG} Test Resident`,
        email: residentEmail,
        phone: "03000000000",
        cnic: `9999-${String(Date.now()).slice(-7)}-9`,
        status: "Active",
      })
      .select("id, email")
      .single();

    if (residentError || !resident) {
      fail("Resident creation", residentError ?? new Error("no row returned"));
      return;
    }

    residentId = resident.id;
    cleanup.push(async () => {
      await admin.from("residents").delete().eq("id", residentId);
    });
    record("Resident creation", "pass", `residents.id=${residentId}`);

    // Portal login + temporary password (admin-authenticated HTTP route).
    if (staffToken) {
      const { status, payload } = await post(
        "/api/residents/create-login",
        { residentId },
        staffToken,
      );
      const created = status === 200 && Boolean(payload?.temporaryPassword);
      check(
        "Portal login created with a temporary password",
        created,
        created ? "" : `HTTP ${status} ${payload?.error ?? ""}`,
      );

      if (created) {
        temporaryPassword = payload.temporaryPassword;

        const { data: authUsers } = await admin.auth.admin.listUsers({
          page: 1,
          perPage: 200,
        });
        const authUser = (authUsers?.users ?? []).find(
          (user) => (user.email ?? "").toLowerCase() === residentEmail.toLowerCase(),
        );
        check(
          "Supabase auth user exists for the resident",
          Boolean(authUser),
          authUser ? `metadata.resident_id=${authUser.user_metadata?.resident_id ?? "-"}` : "",
        );
        if (authUser) {
          cleanup.push(async () => {
            await admin.auth.admin.deleteUser(authUser.id);
          });
        }
      }
    } else {
      record("Portal login created with a temporary password", "skip", "needs a staff session");
    }

    // === Phase 2: admission + contract ===================================
    const { data: templates, error: templateLookupError } = await admin
      .from("contract_templates")
      .select("id, content, is_active")
      .eq("is_active", true);

    const activeTemplates = templates ?? [];
    const templateOk = check(
      "Exactly one active contract template exists",
      !templateLookupError && activeTemplates.length === 1,
      templateLookupError
        ? templateLookupError.message
        : `${activeTemplates.length} active template(s) - the admission form refuses 0 or >1`,
    );

    const { data: beds } = await admin
      .from("beds")
      .select("id, bed_number, room_id, status")
      .in("status", ["Vacant"])
      .limit(1);

    const bed = (beds ?? [])[0] ?? null;
    if (!check("A vacant bed is available for allocation", Boolean(bed))) {
      return;
    }

    bedId = bed.id;
    previousBedStatus = bed.status;
    const { error: bedClaimError } = await admin
      .from("beds")
      .update({ status: "Occupied" })
      .eq("id", bedId)
      .eq("status", previousBedStatus);
    check("Bed claimed for the admission", !bedClaimError, bedClaimError?.message ?? "");
    cleanup.push(async () => {
      await admin.from("beds").update({ status: previousBedStatus }).eq("id", bedId);
    });

    const monthlyRent = 15000;
    const { data: admission, error: admissionError } = await admin
      .from("admissions")
      .insert({
        resident_id: residentId,
        room_id: bed.room_id,
        bed_id: bedId,
        admission_date: new Date().toISOString().slice(0, 10),
        monthly_rent: monthlyRent,
        security_deposit: monthlyRent,
        deposit_status: "Pending",
        status: "Pending",
      })
      .select("id, monthly_rent, status")
      .single();

    if (admissionError || !admission) {
      fail("Admission creation", admissionError ?? new Error("no row returned"));
      return;
    }

    admissionId = admission.id;
    cleanup.push(async () => {
      await admin.from("admissions").delete().eq("id", admissionId);
    });
    record("Admission creation", "pass", `status=${admission.status}, rent=${admission.monthly_rent}`);

    if (templateOk) {
      const template = activeTemplates[0];
      const { data: contract, error: contractError } = await admin
        .from("contracts")
        .insert({
          contract_number: `${TAG}-CONTRACT`,
          resident_id: residentId,
          admission_id: admissionId,
          template_id: template.id,
          contract_content: template.content,
          start_date: new Date().toISOString().slice(0, 10),
          monthly_rent: monthlyRent,
          security_deposit: monthlyRent,
          status: "Pending Signature",
        })
        .select("id, template_id, admission_id, contract_content")
        .single();

      if (contractError || !contract) {
        fail("Contract generated from the active template", contractError ?? new Error("no row"));
      } else {
        cleanup.push(async () => {
          await admin.from("contracts").delete().eq("id", contract.id);
        });
        check(
          "Contract generated from the active template and linked to the admission",
          contract.template_id === template.id &&
            contract.admission_id === admissionId &&
            Boolean(String(contract.contract_content ?? "").trim()),
        );
      }
    }

    // === Phase 3: resident portal ========================================
    if (temporaryPassword) {
      const residentAuth = createClient(url, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: session, error: signInError } =
        await residentAuth.auth.signInWithPassword({
          email: residentEmail,
          password: temporaryPassword,
        });

      if (signInError || !session.session) {
        fail("Resident sign-in with the temporary password", signInError ?? new Error("no session"));
      } else {
        residentToken = session.session.access_token;
        record("Resident sign-in with the temporary password", "pass", "");
        check(
          "Resident is flagged to change the temporary password",
          session.user?.user_metadata?.must_change_password === true,
        );

        const portal = await get("/api/resident-portal/data", residentToken);
        const data = portal.payload?.data ?? null;
        if (!check("Resident portal data loads", portal.status === 200 && Boolean(data),
          portal.status === 200 ? "" : `HTTP ${portal.status} ${portal.payload?.error ?? ""}`)) {
          // keep going: later phases still report usefully
        } else {
          check("Portal shows the current admission", data.admission?.id === admissionId);
          check("Portal shows the room details", Boolean(data.room?.room_number));
          check("Portal shows the bed details", Boolean(data.bed?.bed_number));
          check("Portal shows the contract", data.contract?.admission_id === admissionId);
        }
      }
    } else {
      record("Resident portal data loads", "skip", "no temporary password available");
    }

    // Activation is deliberately not fabricated by the fixture. Complete staff signature
    // approval and deposit verification before running bulk billing assertions.
    // === Phase 4: bulk generation ========================================
    const month = billingMonth();
    if (staffToken) {
      const { status, payload } = await post(
        "/api/billing/bulk-generate",
        { billingMonth: month },
        staffToken,
      );
      const ok = check(
        "Bulk generation succeeds",
        status === 200 && typeof payload?.createdCount === "number",
        status === 200 ? `created=${payload?.createdCount}` : `HTTP ${status} ${payload?.error ?? ""}`,
      );

      if (ok) {
        const { data: bill } = await admin
          .from("bills")
          .select("id, bill_status, due_date, rent_amount, total_amount, billing_month")
          .eq("admission_id", admissionId)
          .eq("billing_month", month)
          .maybeSingle();

        if (check("A bill was generated for the test admission", Boolean(bill))) {
          generatedBillId = bill.id;
          cleanup.push(async () => {
            await admin.from("bills").delete().eq("id", generatedBillId);
          });
          check(
            "Generated bill starts as Pending Approval",
            bill.bill_status === "Pending Approval",
            `bill_status=${bill.bill_status}`,
          );
          check(
            "Initial Rent is due on admission",
            String(bill.due_date).slice(0, 10) === new Date().toISOString().slice(0, 10),
            `due_date=${bill.due_date}, expected=${new Date().toISOString().slice(0, 10)}`,
          );
          check(
            "Rent is pulled from the active admission",
            Number(bill.rent_amount) === monthlyRent &&
              Number(bill.total_amount) === monthlyRent,
          );
        }

        // Re-running must not duplicate.
        const second = await post("/api/billing/bulk-generate", { billingMonth: month }, staffToken);
        const skippedForAdmission = (second.payload?.skipped ?? []).some(
          (entry) => entry.admissionId === admissionId,
        );
        check(
          "Re-running bulk generation skips the existing bill",
          second.status === 200 && skippedForAdmission,
          skippedForAdmission ? "" : "the second run did not report this admission as skipped",
        );
      }
    } else {
      record("Bulk generation succeeds", "skip", "needs a staff session");
    }

    // === Phase 5: approval + resident visibility =========================
    if (generatedBillId && residentToken) {
      const before = await get("/api/resident-portal/data", residentToken);
      const beforeBills = before.payload?.data?.bills ?? [];
      check(
        "Unapproved bill is hidden from the resident portal",
        !beforeBills.some((bill) => bill.id === generatedBillId),
        `${beforeBills.length} bill(s) visible before approval`,
      );
    }

    if (generatedBillId && staffToken) {
      const { status, payload } = await post(
        "/api/billing/approve",
        { billIds: [generatedBillId] },
        staffToken,
      );
      check(
        "Approval succeeds",
        status === 200 && payload?.approvedCount === 1,
        status === 200
          ? `emailStatus=${payload?.outcomes?.[0]?.emailStatus}`
          : `HTTP ${status} ${payload?.error ?? ""}`,
      );

      const { data: approved } = await admin
        .from("bills")
        .select("bill_status")
        .eq("id", generatedBillId)
        .maybeSingle();
      check(
        "Approved bill moves to Pending",
        approved?.bill_status === "Pending",
        `bill_status=${approved?.bill_status}`,
      );

      const repeat = await post("/api/billing/approve", { billIds: [generatedBillId] }, staffToken);
      check(
        "Re-approving an already released bill is rejected",
        repeat.status === 200 && repeat.payload?.approvedCount === 0,
        repeat.payload?.outcomes?.[0]?.reason ?? "",
      );

      if (residentToken) {
        const after = await get("/api/resident-portal/data", residentToken);
        const afterBills = after.payload?.data?.bills ?? [];
        check(
          "Approved bill becomes visible to the resident",
          afterBills.some((bill) => bill.id === generatedBillId),
          `${afterBills.length} bill(s) visible after approval`,
        );
      }
    } else if (!staffToken) {
      record("Approval succeeds", "skip", "needs a staff session");
    }

    // === Phase 6: security ===============================================
    const noToken = await post("/api/billing/bulk-generate", { billingMonth: month });
    check(
      "Bulk generation rejects unauthenticated callers",
      noToken.status === 401 || noToken.status === 403,
      `HTTP ${noToken.status}`,
    );

    const noTokenApprove = await post("/api/billing/approve", { billIds: [generatedBillId || "x"] });
    check(
      "Approval rejects unauthenticated callers",
      noTokenApprove.status === 401 || noTokenApprove.status === 403,
      `HTTP ${noTokenApprove.status}`,
    );

    if (residentToken) {
      const residentGenerate = await post(
        "/api/billing/bulk-generate",
        { billingMonth: month },
        residentToken,
      );
      check(
        "Residents cannot call the billing generation route",
        residentGenerate.status === 401 || residentGenerate.status === 403,
        `HTTP ${residentGenerate.status}`,
      );

      const residentApprove = await post(
        "/api/billing/approve",
        { billIds: [generatedBillId || "x"] },
        residentToken,
      );
      check(
        "Residents cannot call the billing approval route",
        residentApprove.status === 401 || residentApprove.status === 403,
        `HTTP ${residentApprove.status}`,
      );

      // Direct table access with the resident's own token: this is what the
      // RLS policies allow, independent of the API routes.
      const residentDb = createClient(url, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${residentToken}` } },
      });
      const { data: staffRows } = await residentDb.from("staff_users").select("email").limit(1);
      check(
        "RLS stops a resident from reading staff_users directly",
        (staffRows ?? []).length === 0,
        (staffRows ?? []).length === 0
          ? ""
          : "a resident token can read staff_users - see supabase/security/rls_hardening_proposal.sql",
      );

      const { data: otherResidents } = await residentDb
        .from("residents")
        .select("id, cnic")
        .neq("id", residentId)
        .limit(1);
      check(
        "RLS stops a resident from reading other residents' personal records",
        (otherResidents ?? []).length === 0,
        (otherResidents ?? []).length === 0
          ? ""
          : "a resident token can read other residents' records",
      );
    }
  } catch (error) {
    fail("Unexpected failure", error);
  } finally {
    for (const step of cleanup.reverse()) {
      try {
        await step();
      } catch (error) {
        console.warn(`[WARN] cleanup step failed: ${error instanceof Error ? error.message : error}`);
      }
    }
    console.log("\nTest data removed.");
  }

  const failed = results.filter((entry) => entry.status === "fail");
  const skipped = results.filter((entry) => entry.status === "skip");
  console.log(
    `\n${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped.`,
  );
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
