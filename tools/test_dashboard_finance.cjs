// Pure dashboard finance projections: no SDK, credentials, network, or database writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
let ts;
try { ts = require('typescript'); } catch { ts = require('../.local-checks/typescript/package/lib/typescript.js'); }
const allowed = new Set(['dashboardFinance', 'dashboardRent', 'residentFinancialSummary', 'paymentAllocations', 'financialMath', 'billApproval']);
const cache = new Map();
function load(name) {
  name = name.replace(/^.*\//, '').replace(/\.ts$/, '');
  assert.ok(allowed.has(name), `Non-pure module blocked: ${name}`);
  if (cache.has(name)) return cache.get(name);
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', `${name}.ts`), 'utf8');
  const loaded = { exports: {} };
  cache.set(name, loaded.exports);
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  vm.runInNewContext(`(function(require,module,exports){${js}\n})`, {}, { timeout: 2000 })((id) => load(id), loaded, loaded.exports);
  return loaded.exports;
}
const finance = load('dashboardFinance');
const admission = (rent, deposit = 0, status = 'Active', depositStatus = 'Pending') => ({
  id: 'current', resident_id: 'resident', status, monthly_rent: rent,
  security_deposit: deposit, deposit_status: depositStatus,
});
const rentBill = (total, status = 'Pending', admissionId = 'current') => ({
  id: `rent-${admissionId}`, resident_id: 'resident', admission_id: admissionId,
  bill_type: 'Rent', rent_amount: total, total_amount: total, bill_status: status,
});
const depositBill = (total, status = 'Pending', admissionId = 'current') => ({
  id: `deposit-${admissionId}`, resident_id: 'resident', admission_id: admissionId,
  bill_type: 'Security Deposit', total_amount: total, bill_status: status,
});
const payment = (id, amount, status, billId = null, allocations = undefined) => ({
  id, resident_id: 'resident', amount, payment_status: status, bill_id: billId,
  ...(allocations ? { payment_allocations: allocations.map(([bill_id, allocationAmount]) => ({ bill_id, amount: allocationAmount })) } : {}),
});
const fee = (billId, payable, status = 'Charged') => ({ id: `fee-${billId}`, bill_id: billId, payable_amount: payable, status });
const totals = (admissions, bills, payments, fees = [], feePayments = []) => ({
  revenue: finance.dashboardOperatingRevenue(payments, bills, feePayments),
  held: finance.dashboardSecurityDepositsHeld(admissions, bills, payments),
  dues: finance.dashboardCurrentAdmissionDues(admissions, bills, payments, fees),
});

const unpaid = [rentBill(18000), depositBill(18000)];
assert.deepEqual(JSON.parse(JSON.stringify(totals([admission(18000, 18000)], unpaid, []))), { revenue: 0, held: 0, dues: 36000 });
console.log('PASS A unpaid Rent + Deposit: dues 36000, held 0');

const combined = payment('combined', 36000, 'Verified', null, [['rent-current', 18000], ['deposit-current', 18000]]);
assert.deepEqual(JSON.parse(JSON.stringify(totals([admission(18000, 18000)], [rentBill(18000, 'Paid'), depositBill(18000)], [combined]))), { revenue: 18000, held: 18000, dues: 0 });
console.log('PASS B combined Rent + Deposit: Revenue 18000, Held 18000, dues 0');

const rentPlusExtraBills = [rentBill(15000, 'Paid'), { id: 'extra', resident_id: 'resident', admission_id: 'current', bill_type: 'Other Charges', other_amount: 5140, total_amount: 5140, bill_status: 'Paid' }];
const rentPlusExtra = payment('rent-extra', 20140, 'Verified', null, [['rent-current', 15000], ['extra', 5140]]);
assert.deepEqual(JSON.parse(JSON.stringify(totals([admission(15000)], rentPlusExtraBills, [rentPlusExtra]))), { revenue: 20140, held: 0, dues: 0 });
console.log('PASS C Rent + Additional Charges: Revenue 20140 once, dues 0');

const tripleBills = [rentBill(15000, 'Paid'), depositBill(15000, 'Paid'), { id: 'extra', resident_id: 'resident', admission_id: 'current', bill_type: 'Other Charges', other_amount: 5140, total_amount: 5140, bill_status: 'Paid' }];
const triple = payment('triple', 35140, 'Verified', null, [['rent-current', 15000], ['deposit-current', 15000], ['extra', 5140]]);
const tripleTotals = totals([admission(15000, 15000)], tripleBills, [triple]);
assert.deepEqual(JSON.parse(JSON.stringify(tripleTotals)), { revenue: 20140, held: 15000, dues: 0 });
assert.equal(tripleTotals.revenue + tripleTotals.held, 35140);
assert.equal(finance.dashboardOperatingRevenue([triple, triple], tripleBills, []), 20140, 'duplicate parent row joins do not double-count');
console.log('PASS D Rent + Deposit + Additional: Revenue 20140, Held 15000, dues 0, combined 35140');

assert.deepEqual(JSON.parse(JSON.stringify(totals([admission(17000)], [rentBill(17000)], [payment('pending-rent', 17000, 'Pending', 'rent-current')]))), { revenue: 0, held: 0, dues: 17000 });
console.log('PASS E pending Rent payment gives no revenue or credit');
assert.deepEqual(JSON.parse(JSON.stringify(totals([admission(17000)], [rentBill(17000)], [payment('partial-rent', 10000, 'Verified', 'rent-current')]))), { revenue: 10000, held: 0, dues: 7000 });
console.log('PASS F verified partial Rent');
assert.deepEqual(JSON.parse(JSON.stringify(totals([admission(17000)], [rentBill(17000)], [payment('reversed-rent', 10000, 'Cancelled', 'rent-current')]))), { revenue: 0, held: 0, dues: 17000 });
console.log('PASS G reversed Rent removes revenue and restores dues');

assert.deepEqual(JSON.parse(JSON.stringify(totals([admission(0, 18000)], [depositBill(18000)], [payment('partial-deposit', 10000, 'Verified', 'deposit-current')]))), { revenue: 0, held: 10000, dues: 8000 });
console.log('PASS H partial verified Deposit is held, excluded from revenue, with 8000 due');
const heldAdmission = admission(0, 18000, 'Completed', 'Held');
assert.equal(finance.dashboardSecurityDepositsHeld([heldAdmission], [depositBill(18000, 'Paid')], [payment('historic-held', 18000, 'Verified', 'deposit-current')]), 18000);
assert.equal(finance.dashboardSecurityDepositsHeld([admission(0, 18000, 'Completed', 'Released')], [depositBill(18000, 'Paid')], [payment('released', 18000, 'Verified', 'deposit-current')]), 0);
assert.equal(finance.dashboardSecurityDepositsHeld([admission(0, 18000, 'Completed', 'Deducted')], [depositBill(18000, 'Paid')], [payment('deducted', 18000, 'Verified', 'deposit-current')]), 0);
assert.equal(finance.dashboardSecurityDepositsHeld([admission(0, 18000)], [depositBill(18000)], [payment('deposit-reversed', 10000, 'Cancelled', 'deposit-current')]), 0);
assert.equal(finance.dashboardSecurityDepositsHeld([admission(0, 0, 'Pending', 'Held')], [], []), 0);
console.log('PASS I-K deposit reversal/release/deduction/zero and historical Held lifecycle');

const paidRent = rentBill(18000, 'Paid');
const feeRows = [fee(paidRent.id, 1800)];
const rentSettled = payment('rent-settled', 18000, 'Verified', paidRent.id);
assert.equal(finance.dashboardCurrentAdmissionDues([admission(18000)], [paidRent], [rentSettled], feeRows), 1800);
assert.equal(finance.dashboardCurrentAdmissionDues([admission(18000)], [paidRent], [rentSettled], [fee(paidRent.id, 0, 'Calculated')]), 0);
assert.equal(finance.dashboardCurrentAdmissionDues([admission(18000)], [paidRent], [rentSettled], [fee(paidRent.id, 0, 'Waived')]), 0);
assert.equal(finance.dashboardCurrentAdmissionDues([admission(18000)], [paidRent], [rentSettled], [fee(paidRent.id, 1800, 'Frozen')]), 1800);
const feePayment = payment('fee-payment', 1800, 'Verified');
const appliedFee = { payment_id: 'fee-payment', amount: 1800, applied_at: '2026-10-01T00:00:00Z', reversed_at: null };
assert.equal(finance.dashboardOperatingRevenue([feePayment], [paidRent], [appliedFee]), 1800);
assert.equal(finance.dashboardCurrentAdmissionDues([admission(18000)], [paidRent], [rentSettled], [fee(paidRent.id, 0, 'Paid')]), 0);
const reversedFeePayment = { ...feePayment, payment_status: 'Cancelled' };
const reversedFee = { ...appliedFee, reversed_at: '2026-10-02T00:00:00Z' };
assert.equal(finance.dashboardOperatingRevenue([reversedFeePayment], [paidRent], [reversedFee]), 0);
assert.equal(finance.dashboardCurrentAdmissionDues([admission(18000)], [paidRent], [rentSettled], [fee(paidRent.id, 1800, 'Charged')]), 1800);
console.log('PASS L-P payable/frozen/grace/waived/verified/reversed Late Fee lifecycle');

const rawCombined = payment('raw-combined', 36000, 'Verified', null, [['rent-current', 18000], ['deposit-current', 18000]]);
assert.equal(finance.dashboardOperatingRevenue([rawCombined], [rentBill(18000), depositBill(18000)], []), 18000);
assert.equal(finance.dashboardCurrentAdmissionDues([admission(18000, 18000)], [rentBill(18000, 'Paid'), depositBill(18000)], [rawCombined], []), 0);
assert.equal(finance.dashboardOperatingRevenue([payment('legacy-rent', 5000, 'Verified', 'rent-current')], [rentBill(18000)], []), 5000);
assert.equal(finance.dashboardOperatingRevenue([payment('legacy-deposit', 18000, 'Verified', 'deposit-current')], [depositBill(18000)], []), 0);
assert.equal(finance.dashboardOperatingRevenue([payment('pending', 18000, 'Pending', 'rent-current'), payment('rejected', 18000, 'Rejected', 'rent-current'), payment('cancelled', 18000, 'Cancelled', 'rent-current')], [rentBill(18000)], []), 0);
const currentAdmission = admission(17000);
const oldAdmission = { ...admission(12000, 0, 'Completed'), id: 'old' };
const currentBill = rentBill(17000);
const oldBill = { ...rentBill(12000, 'Paid', 'old'), id: 'rent-old', admission_id: 'old' };
assert.equal(finance.dashboardCurrentAdmissionDues([currentAdmission, oldAdmission], [currentBill, oldBill], [payment('old-payment', 12000, 'Verified', 'rent-old')], []), 17000);
for (const status of ['Cancelled', 'Draft', 'Pending Approval']) {
  assert.equal(finance.dashboardCurrentAdmissionDues([admission(0)], [{ ...rentBill(5000, status), rent_amount: 0, bill_type: 'Other Charges', other_amount: 5000 }], [], []), 0, `${status} bills are excluded from current dues`);
}
const chartSource = fs.readFileSync(path.join(__dirname, '..', 'components/dashboard/DashboardCharts.tsx'), 'utf8');
assert.match(chartSource, /dashboardVerifiedPaymentRevenue\(payments, bills, lateFeeAllocations\)/);
assert.doesNotMatch(chartSource, /pStatus === "completed"|pStatus === "approved"/);
console.log('PASS Q-T raw PostgREST normalization, legacy fallback, status filters, allocation purpose split, no deposit revenue/double count');
