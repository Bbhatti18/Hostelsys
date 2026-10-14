const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const vm = require("node:vm");

// 1. Test lib/lateFee.ts logic
const lateFeeSource = fs.readFileSync("lib/lateFee.ts", "utf8");
const lateFeeMod = { exports: {} };
vm.runInNewContext(
  ts.transpileModule(lateFeeSource, {}).outputText,
  { module: lateFeeMod, exports: lateFeeMod.exports, Intl, Date }
);
const { calculateLateFee, lateFeePayable } = lateFeeMod.exports;

// Case: Due date is 2026-10-10, as of 2026-10-10 (same day) -> 0
assert.equal(calculateLateFee("2026-10-10", "2026-10-10"), 0);

// Case: Due date is 2026-10-10, as of 2026-10-11 (1 day overdue) -> Rs. 300
assert.equal(calculateLateFee("2026-10-10", "2026-10-11"), 300);

// Case: Due date is 2026-10-10, as of 2026-10-14 (4 days overdue) -> Rs. 1200
assert.equal(calculateLateFee("2026-10-10", "2026-10-14"), 1200);

// Case: Due date is 2026-10-25, as of 2026-10-14 (future) -> 0
assert.equal(calculateLateFee("2026-10-25", "2026-10-14"), 0);

// Test payable calculation
assert.equal(lateFeePayable(1200, 1200), 0); // Full waiver
assert.equal(lateFeePayable(1200, 400), 800); // Partial waiver
assert.equal(lateFeePayable(1200, 0), 1200); // Rejected waiver

console.log("✓ PASS lateFee Rs. 300/day calculations verified.");

// 2. Test live Supabase integration for fine waiver requests
(async () => {
  const envContent = fs.readFileSync(".env", "utf8");
  let url = "", key = "";
  for (const line of envContent.split("\n")) {
    if (line.startsWith("NEXT_PUBLIC_SUPABASE_URL=")) url = line.split("=")[1].trim();
    if (line.startsWith("SUPABASE_SERVICE_ROLE_KEY=")) key = line.split("=")[1].trim();
  }
  const { createClient } = require("@supabase/supabase-js");
  const supabase = createClient(url, key);

  // Pick a real bill or resident from DB
  const { data: bill } = await supabase.from("bills").select("id, resident_id, total_amount, due_date").limit(1).single();
  if (!bill) {
    console.log("No bills found in test DB, skipping live db test.");
    return;
  }

  const testResidentId = bill.resident_id;
  const testBillId = bill.id;
  const testFine = 1200;

  // Transpile and load lib/fineWaivers
  const fineWaiversSource = fs.readFileSync("lib/fineWaivers.ts", "utf8");
  const fineWaiversMod = { exports: {} };
  const adminClient = supabase;

  vm.runInNewContext(
    ts.transpileModule(fineWaiversSource, {}).outputText,
    {
      module: fineWaiversMod,
      exports: fineWaiversMod.exports,
      require: (id) => {
        if (id === "@/lib/supabaseAdmin") return { supabaseAdmin: adminClient };
        if (id === "@/lib/lateFee") return lateFeeMod.exports;
        return require(id);
      },
      crypto,
      Date,
      console,
    }
  );

  const {
    createWaiverRequest,
    getResidentWaiverRequests,
    getAllWaiverRequests,
    reviewWaiverRequest,
  } = fineWaiversMod.exports;

  // Clean up any test records first
  const existingWaivers = await getResidentWaiverRequests(testResidentId);
  for (const w of existingWaivers) {
    if (w.reason?.startsWith("[TEST_AUTOMATED]")) {
      await supabase.from("system_settings").delete().eq("setting_key", `fine_waiver_req:${w.id}`);
    }
  }

  // A. Create a test waiver request
  const createRes = await createWaiverRequest({
    residentId: testResidentId,
    billId: testBillId,
    fineAmount: testFine,
    requestedAmount: testFine,
    reason: "[TEST_AUTOMATED] Student suffered medical emergency and was hospitalized.",
  });

  assert.ok(createRes.data, "Should create waiver request successfully");
  assert.equal(createRes.data.status, "Pending");
  assert.equal(createRes.data.fine_amount, 1200);
  console.log("✓ PASS createWaiverRequest created pending request:", createRes.data.id);

  // B. Retrieve requests
  const residentRequests = await getResidentWaiverRequests(testResidentId);
  const found = residentRequests.find((r) => r.id === createRes.data.id);
  assert.ok(found, "Should find created request for resident");
  assert.equal(found.status, "Pending");
  console.log("✓ PASS getResidentWaiverRequests verified.");

  const allRequests = await getAllWaiverRequests();
  const foundInAll = allRequests.find((r) => r.id === createRes.data.id);
  assert.ok(foundInAll, "Should find request in admin list");
  console.log("✓ PASS getAllWaiverRequests verified.");

  // C. Test Partial Waiver
  const partialRes = await reviewWaiverRequest({
    requestId: createRes.data.id,
    action: "PARTIAL_WAIVER",
    waivedAmount: 600,
    adminNotes: "Approved 50% waiver upon medical slip verification.",
    reviewerEmail: "admin@hostel.edu.pk",
  });

  assert.ok(partialRes.data, "Should review partial waiver successfully");
  assert.equal(partialRes.data.status, "Partially Approved");
  assert.equal(partialRes.data.waived_amount, 600);
  console.log("✓ PASS reviewWaiverRequest (PARTIAL_WAIVER) verified: waived Rs. 600.");

  // D. Test Full Waiver
  const fullRes = await reviewWaiverRequest({
    requestId: createRes.data.id,
    action: "FULL_WAIVER",
    adminNotes: "Warden approved 100% full hardship waiver.",
    reviewerEmail: "admin@hostel.edu.pk",
  });

  assert.ok(fullRes.data, "Should review full waiver successfully");
  assert.equal(fullRes.data.status, "Approved");
  assert.equal(fullRes.data.waived_amount, 1200);
  console.log("✓ PASS reviewWaiverRequest (FULL_WAIVER) verified: waived 100% (Rs. 1200).");

  // E. Test Reject
  const rejectRes = await reviewWaiverRequest({
    requestId: createRes.data.id,
    action: "REJECT",
    adminNotes: "Insufficient proof provided.",
    reviewerEmail: "admin@hostel.edu.pk",
  });

  assert.ok(rejectRes.data, "Should review rejection successfully");
  assert.equal(rejectRes.data.status, "Rejected");
  assert.equal(rejectRes.data.waived_amount, 0);
  console.log("✓ PASS reviewWaiverRequest (REJECT) verified.");

  // Clean up test entry
  await supabase.from("system_settings").delete().eq("setting_key", `fine_waiver_req:${createRes.data.id}`);
  console.log("✓ Cleaned up test record.");

  console.log("\nALL FINE WAIVER TESTS PASSED SUCCESSFULLY! 🚀");
})().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
