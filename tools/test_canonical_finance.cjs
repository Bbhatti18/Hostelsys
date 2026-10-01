// Isolated tests: only local pure modules may be imported. No application initialization,
// environment files, network clients, database commands, or connected fixtures.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
let ts;
try { ts = require("typescript"); } catch { ts = require("../.local-checks/typescript/package/lib/typescript.js"); }
const allowed = new Set(["residentFinancialSummary", "financialMath", "billApproval", "residentPaymentHistory", "paymentReceiptPurpose", "paymentObligations", "paymentAllocations", "canonical", "contractWorkflow", "noticeVisibility"]);
const cache = new Map();
function load(name) {
  name = name.replace(/^.*\//, "").replace(/\.ts$/, "");
  assert(allowed.has(name), `Non-pure import blocked: ${name}`);
  if (cache.has(name)) return cache.get(name);
  const source = fs.readFileSync(path.join(__dirname, "..", "lib", `${name}.ts`), "utf8");
  const loadedModule = { exports: {} };
  cache.set(name, loadedModule.exports);
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  vm.runInNewContext(`(function(require,module,exports){${code}\n})`, {}, { timeout: 2000 })(load, loadedModule, loadedModule.exports);
  return loadedModule.exports;
}
const { buildResidentFinancialSummary: summary } = load("residentFinancialSummary");
const { buildResidentPaymentHistory } = load("residentPaymentHistory");
const { combinedPaymentPreview, combinedPaymentAllocationError, billPaymentObligation, receiptPurposeError } = load("paymentObligations");
const { combinedPaymentAllocations, allocationTotal, paymentBillAmounts } = load("paymentAllocations");
for (const payment_status of ['Pending', 'Rejected', 'Cancelled', 'Unexpected', undefined]) {
  assert.equal(paymentBillAmounts({ bill_id: 'rent', amount: 100, payment_status }, [{bill_id:'rent', amount:100}]).length, 0, `${payment_status} allocations must give no credit`);
}
const current = { id: "current", status: "Pending", monthly_rent: 18000, security_deposit: 18000, deposit_status: "Pending" };
const rent = { id: "rent", admission_id: "current", bill_type: "Rent", billing_month: "2026-09", rent_amount: 18000, total_amount: 18000, bill_status: "Pending" };
const deposit = { id: "deposit", admission_id: "current", bill_type: "Security Deposit", billing_month: "Security Deposit", total_amount: 18000, bill_status: "Pending" };
const payment = (bill_id, amount, payment_status = "Verified") => ({ id: `${bill_id}-${payment_status}`, bill_id, amount, payment_status });
function calculate(payments = [], admission = current, bills = [rent, deposit]) { return summary({ admission, room: null, bed: null, bills, payments }); }
function check(name, result, rentDue, depositDue, total) {
  assert.equal(result.monthlyRentDue, rentDue, `${name}: rent`);
  assert.equal(result.depositBalance, depositDue, `${name}: deposit`);
  assert.equal(result.totalOutstanding, total, `${name}: total`);
  assert.equal(result.totalOutstanding, Math.round((result.monthlyRentDue + result.depositBalance + result.utilityItems.reduce((n, x) => n + x.amount, 0) + result.otherItems.reduce((n, x) => n + x.amount, 0)) * 100) / 100);
  console.log(`PASS ${name}`);
}
check("A both unpaid", calculate(), 18000, 18000, 36000);
check("A rent unbilled", calculate([], current, [deposit]), 18000, 18000, 36000);
check("B deposit verified", calculate([payment("deposit", 18000)]), 18000, 0, 18000);
check("B Held deposit does not duplicate bill", calculate([], { ...current, deposit_status: "Held" }), 18000, 0, 18000);
check("C rent verified", calculate([payment("rent", 18000)]), 0, 18000, 18000);
check("D partial payments", calculate([payment("rent", 8000), payment("deposit", 5000)]), 10000, 13000, 23000);
check("E fully paid", calculate([payment("rent", 18000), payment("deposit", 18000)]), 0, 0, 0);
const preview = combinedPaymentPreview(calculate());
assert.equal(preview.total, 36000);
assert.equal(preview.allocations.find(x => x.purpose === "Rent").amount, 18000);
assert.equal(preview.allocations.find(x => x.purpose === "Security Deposit").amount, 18000);
assert.equal(preview.canSubmit, true);
assert.equal(JSON.stringify(combinedPaymentAllocations(18000, 18000, 36000)), JSON.stringify([{ purpose: "Rent", amount: 18000 }, { purpose: "Security Deposit", amount: 18000 }]));
assert.equal(JSON.stringify(combinedPaymentAllocations(12000, 7000, 19000)), JSON.stringify([{ purpose: "Rent", amount: 12000 }, { purpose: "Security Deposit", amount: 7000 }]));
assert.equal(combinedPaymentAllocations(12000, 7000, 18000), null);
assert.equal(combinedPaymentAllocations(0, 7000, 7000), null);
assert.equal(combinedPaymentAllocationError(calculate(), 36000), null);
assert.ok(combinedPaymentAllocationError(calculate(), 35999));
assert.equal(allocationTotal([{ amount: 18000 }, { amount: 18000 }]), 36000);
assert.equal(paymentBillAmounts({ amount: 18000, bill_id: "rent", payment_status: "Verified" }, [] )[0].bill_id, "rent");
assert.equal(paymentBillAmounts({ amount: 36000, bill_id: null, payment_status: "Verified" }, [{ bill_id: "rent", amount: 18000 }, { bill_id: "deposit", amount: 18000 }]).length, 2);
const combinedPayment = (status = "Verified", rentAmount = 18000, depositAmount = 18000) => ({ id: `combined-${status}`, bill_id: null, amount: rentAmount + depositAmount, payment_status: status, allocations: [{ bill_id: "rent", amount: rentAmount }, { bill_id: "deposit", amount: depositAmount }] });
check("Combined pending does not reduce either bill", calculate([combinedPayment("Pending")]), 18000, 18000, 36000);
check("Combined rejected does not reduce either bill", calculate([combinedPayment("Rejected")]), 18000, 18000, 36000);
check("Combined verified reduces both bills", calculate([combinedPayment("Verified")]), 0, 0, 0);
check("Combined reversal restores both bills", calculate([combinedPayment("Cancelled")]), 18000, 18000, 36000);
assert.equal(combinedPaymentAllocations(18000, 18000, 35999), null, "allocation sum mismatch rejected");
assert.equal(combinedPaymentAllocations(18000, 18000, 36001), null, "over-allocation rejected");
console.log("PASS F exact combined allocation and legacy single-bill compatibility");
check("G pending payment", calculate([payment("rent", 18000, "Pending"), payment("deposit", 18000, "Pending")]), 18000, 18000, 36000);
check("H rejected payment", calculate([payment("rent", 18000, "Rejected"), payment("deposit", 18000, "Rejected")]), 18000, 18000, 36000);
check("Cancelled payments", calculate([payment("rent", 18000, "Cancelled")]), 18000, 18000, 36000);
check("I historical deposit excluded", calculate([payment("old-deposit", 18000)], current, [{ ...deposit, id: "old-deposit", admission_id: "old" }, rent, deposit]), 18000, 18000, 36000);
check("Different amounts are dynamic", calculate([], { ...current, monthly_rent: 12500, security_deposit: 7000 }, []), 12500, 7000, 19500);
check("Zero rent is not replaced by room rent", summary({ admission: { ...current, monthly_rent: 0 }, room: { monthly_rent: 999 }, bed: null, bills: [], payments: [] }), 0, 18000, 18000);
const history = buildResidentPaymentHistory({ bills: [deposit], payments: [payment("deposit", 18000)], receipts: [{ id: "proof", payment_id: "deposit-Verified", amount: 18000, status: "Verified" }] });
assert.equal(history.entries.length, 1);
assert.equal(history.summary.totalPaid, 18000);
console.log("PASS linked receipt/payment counted once in history");
for (const state of ["Cancelled", "Rejected", "Pending"]) {
  check("Stale Held with " + state, calculate([payment("deposit", 18000, state)], { ...current, deposit_status: "Held" }), 18000, 18000, 36000);
}
check("Stale Held after partial reversal", calculate([payment("deposit", 5000), payment("deposit", 13000, "Cancelled")], { ...current, deposit_status: "Held" }), 18000, 13000, 31000);
check("Cancelled deposit bill does not waive admission deposit", calculate([], { ...current, deposit_status: "Held" }, [rent, { ...deposit, bill_status: "Cancelled" }]), 18000, 18000, 36000);
check("No current admission excludes history", calculate([payment("deposit", 18000)], null), 0, 0, 0);
check("Completed admission is not current", calculate([], { ...current, status: "Completed", deposit_status: "Held" }), 0, 0, 0);
const partial = [payment("rent", 8000), payment("deposit", 5000)];
assert.equal(billPaymentObligation(rent, partial).amount, 10000);
assert.equal(billPaymentObligation(deposit, partial).amount, 13000);
assert.equal(combinedPaymentPreview(calculate(partial)).total, 23000);
assert.equal(combinedPaymentPreview(calculate(partial)).canSubmit, true);
const withUtilities = { ...rent, total_amount: 20000, electricity_amount: 2000 };
assert.equal(billPaymentObligation(withUtilities, []).amount, 18000);
assert.equal(billPaymentObligation(withUtilities, [payment("rent", 18000)]).purpose, "Other Charges");
assert.equal(billPaymentObligation(withUtilities, [payment("rent", 18000)]).amount, 2000);
assert.equal(receiptPurposeError(rent, [], 5000, "Rent"), null);
assert.equal(receiptPurposeError(deposit, [], 5000, "Security Deposit"), null);
assert.ok(receiptPurposeError(deposit, [], 5000, "Rent"));
assert.ok(receiptPurposeError(rent, [], 5000, "Security Deposit"));
assert.ok(receiptPurposeError(rent, [], 5000, "Rent + Security Deposit"));
assert.ok(receiptPurposeError(withUtilities, [], 19000, "Rent"));
assert.ok(receiptPurposeError(rent, partial, 10001, "Rent"));
assert.ok(receiptPurposeError(rent, [], Infinity, "Rent"));
for (const state of ["Cancelled", "Rejected", "Pending"]) {
  const p = payment("deposit", 18000, state);
  const h = buildResidentPaymentHistory({ bills: [deposit], payments: [p], receipts: [{ id: "proof", payment_id: p.id, amount: 18000, status: "Verified" }] });
  assert.equal(h.summary.totalPaid, 0);
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0].status, state);
}
assert.equal(buildResidentPaymentHistory({ bills: [deposit], payments: [], receipts: [{ id: "orphan", amount: 18000, status: "Verified" }] }).summary.totalPaid, 0);
console.log("PASS purpose balances, partial limits, cross-purpose and combined rejection, reversed receipt history");
if (!process.argv.includes("--finance-only")) {
const { billingMonth, bigintId } = load("canonical");
assert.equal(billingMonth("2026-09"), "2026-09");
assert.throws(() => billingMonth("2026-13"));
assert.throws(() => billingMonth("2026-09-01"));
assert.equal(bigintId("9007199254740993"), "9007199254740993");
assert.throws(() => bigintId(9007199254740993));
const workflow = load("contractWorkflow");
const signed = { contract_content: "Agreed", resident_signature_url: "proof", resident_signature_status: "Submitted", signed_by_resident: true, signed_at: "2026-09-01" };
assert.equal(workflow.isAdmissionReadyForActivation("verified", signed), false);
assert.equal(workflow.isAdmissionReadyForActivation("pending", { ...signed, resident_signature_status: "Approved" }), false);
assert.equal(workflow.isAdmissionReadyForActivation("verified", { ...signed, status: "Pending Signature", resident_signature_status: "Approved" }, "verified"), true);
const { isNoticeVisibleToResident, compareNoticeProminence } = load("noticeVisibility");
const notice = { id: 1, audience: "All Residents", status: "Published", publish_date: "2026-09-01" };
assert.equal(isNoticeVisibleToResident(notice, "resident", "room", "2026-09-21"), true);
assert.equal(isNoticeVisibleToResident({ ...notice, publish_date: null }, "resident", "room"), false);
assert.equal(isNoticeVisibleToResident({ ...notice, audience: "Staff" }, "resident", "room"), false);
assert.equal(isNoticeVisibleToResident({ ...notice, audience: "Selected Residents" }, "resident", "room", "2026-09-21", new Set(["1"])), true);
assert.equal(compareNoticeProminence({ ...notice, id: 2 }, { ...notice, id: 10 }) > 0, true);
console.log("PASS month, bigint, lifecycle and notice checks");

}

// Deposit readiness must distinguish absent obligations from actual verification.
{
const workflow = load("contractWorkflow");
const zeroAdmission = { id: 'current', resident_id: 'resident', status: 'Pending', security_deposit: 0, deposit_status: 'Held' };
const depositAdmission = { ...zeroAdmission, security_deposit: 17000 };
const depositBill = { id: 'deposit-current', resident_id: 'resident', admission_id: 'current', bill_type: 'Security Deposit', total_amount: 17000, bill_status: 'Pending' };
const approvedContract = { status: 'Pending Signature', resident_signature_url: 'local-signature', resident_signature_status: 'Approved', signed_by_resident: true, signed_at: '2026-10-01', contract_content: 'Terms' };
const state = (admission, bills, payments) => workflow.getAdmissionDeposit(admission, bills, payments).state;
const payment = (status, amount = 17000) => ({resident_id:'resident',bill_id:'deposit-current',payment_status:status,amount});
assert.equal(state(zeroAdmission, [], []), 'not_required');
assert.equal(workflow.depositStateLabel('not_required'), 'No Deposit Required');
assert.equal(workflow.isDepositVerified('not_required'), false);
assert.equal(workflow.isAdmissionReadyForActivation('not_required', approvedContract, 'verified'), true);
assert.equal(workflow.isAdmissionReadyForActivation('not_required', {...approvedContract,resident_signature_status:'Submitted'}), false);
assert.equal(workflow.isAdmissionReadyForActivation('not_required', null), false);
assert.equal(state(depositAdmission, [], []), 'pending', 'Held alone is not payment evidence');
assert.equal(state(depositAdmission, [depositBill], []), 'pending');
for(const status of ['Pending','Rejected','Cancelled']) assert.equal(state(depositAdmission, [depositBill], [payment(status)]), 'pending');
assert.equal(state(depositAdmission, [depositBill], [payment('Verified', 1000)]), 'pending');
assert.equal(state(depositAdmission, [depositBill], [payment('Verified')]), 'verified');
assert.equal(state(zeroAdmission, [depositBill], []), 'pending', 'Real positive bill overrides zero admission amount');
assert.equal(state(depositAdmission, [{...depositBill,total_amount:0}], []), 'pending', 'Zero bill cannot erase positive required deposit');
assert.equal(state(depositAdmission, [{...depositBill,admission_id:'old'}], [payment('Verified')]), 'pending');
assert.equal(state(depositAdmission, [depositBill], [{...payment('Verified'),resident_id:'other'}]), 'pending');
assert.equal(state(depositAdmission, [depositBill], [{...payment('Verified'),bill_id:'old-deposit'}]), 'pending');
for(const field of ['allocations','payment_allocations']) {
 assert.equal(state(depositAdmission, [depositBill], [{...payment('Verified'),bill_id:null,[field]:[{bill_id:'deposit-current',amount:17000}]}]), 'verified');
 assert.equal(state(depositAdmission, [depositBill], [{...payment('Verified'),[field]:[{bill_id:'old-deposit',amount:17000}]}]), 'pending', 'Allocations supersede direct bill fallback');
}
assert.equal(state(zeroAdmission, undefined, []), 'pending', 'Missing data fails closed');
assert.equal(state({...zeroAdmission,security_deposit:undefined}, [], []), 'pending');
assert.equal(state({...zeroAdmission,security_deposit:''}, [], []), 'pending');
for(const bill_status of ['Draft','Pending Approval','Cancelled']) assert.equal(state(depositAdmission, [{...depositBill,bill_status}], [payment('Verified')]), 'pending');
const frozenAdmission = Object.freeze({...zeroAdmission});
const frozenBills = Object.freeze([]), frozenPayments = Object.freeze([]);
assert.equal(state(frozenAdmission, frozenBills, frozenPayments), 'not_required');
assert.equal(frozenPayments.length,0); assert.equal(frozenAdmission.deposit_status,'Held');
console.log('PASS deposit state/readiness: intentional zero, unpaid, nonverified, partial/full verified, allocation precedence, old/different admission isolation, missing data, contract guards, and no mutations.');
}
