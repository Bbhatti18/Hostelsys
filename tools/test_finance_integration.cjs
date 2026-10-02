// Runs real finance modules against an in-memory client. No SDK, environment files,
// network, SQL or database connection is loaded.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function database(rows) {
  return {
    // RPC contract double: endpoint tests never execute SQL or open a database.
    async rpc(name, args) {
      if(name==='refresh_bill_financials') {
        const bill=rows.bills.find(b=>b.id===args.p_bill_id);
        const effective=rows.payments.filter(p=>p.payment_status==='Verified');
        const paidFor=id=>effective.reduce((sum,p)=>{
          const allocations=rows.payment_allocations.filter(a=>a.payment_id===p.id);
          return sum+(allocations.length?allocations.filter(a=>a.bill_id===id).reduce((n,a)=>n+a.amount,0):(p.bill_id===id?p.amount:0));
        },0);
        const paid=paidFor(bill.id), balance=bill.total_amount-paid;
        const status=bill.bill_status==='Cancelled'?'Cancelled':balance===0?'Paid':paid>0?'Partially Paid':'Pending';
        Object.assign(bill,{paid_amount:paid,balance_amount:balance,bill_status:status});
        if(bill.bill_type==='Security Deposit') {
          const a=rows.admissions.find(a=>a.id===bill.admission_id);
          if(['Pending','Active'].includes(a.status)&&['Pending','Held'].includes(a.deposit_status))a.deposit_status=rows.bills.some(b=>b.admission_id===a.id&&b.bill_type==='Security Deposit'&&b.bill_status!=='Cancelled'&&paidFor(b.id)>=b.total_amount)?'Held':'Pending';
        }
        return {data:{paid,balance,status,total:bill.total_amount},error:null};
      }
      const r = rows.payment_receipts.find(r => r.id === args.p_receipt_id);
      if (!r || r.status !== 'Pending Verification') return {data:null,error:{message:'Receipt changed'}};
      if (name === 'reject_single_payment_receipt') {
        r.status='Rejected';
        const p=rows.payments.find(p=>p.id===r.payment_id);
        if(p)p.payment_status='Rejected';
        return {data:{receipt_id:r.id},error:null};
      }
      assert.equal(name,'verify_single_payment_receipt');
      const b=rows.bills.find(b=>b.id===r.bill_id);
      const paid=rows.payments.filter(p=>p.bill_id===b.id && p.payment_status==='Verified').reduce((n,p)=>n+p.amount,0);
      if(r.amount>b.total_amount-paid)return {data:null,error:{message:'Outstanding changed'}};
      const p={id:'generated-'+(rows.payments.length+1),bill_id:b.id,resident_id:r.resident_id,amount:r.amount,payment_status:'Verified'};
      rows.payments.push(p);
      const allocation={payment_id:p.id,bill_id:b.id,amount:p.amount};
      rows.payment_allocations.push(allocation); p.payment_allocations=[allocation];
      Object.assign(r,{payment_id:p.id,status:'Verified'});
      Object.assign(b,{paid_amount:paid+r.amount,balance_amount:b.total_amount-paid-r.amount,bill_status:paid+r.amount===b.total_amount?'Paid':'Partially Paid'});
      if(b.bill_type==='Security Deposit')rows.admissions.find(a=>a.id===b.admission_id).deposit_status=b.balance_amount===0?'Held':'Pending';
      return {data:{payment_id:p.id},error:null};
    },
    from(table) {
    assert.ok(Object.hasOwn(rows, table), `Unexpected table ${table}`);
    let filters = [], operation = 'select', payload, single = false, limit = Infinity;
    const q = {
      select() { return q; },
      eq(k, v) { filters.push(r => r[k] === v); return q; },
      neq(k, v) { filters.push(r => r[k] !== v); return q; },
      is(k, v) { return q.eq(k, v); },
      in(k, values) { filters.push(r => values.includes(r[k])); return q; },
      ilike(k, v) { filters.push(r => String(r[k]).toLowerCase() === v.toLowerCase()); return q; },
      limit(n) { limit = n; return q; },
      update(value) { operation = 'update'; payload = value; return q; },
      insert(value) { operation = 'insert'; payload = value; return q; },
      single() { single = true; return q; },
      maybeSingle() { single = true; return q; },
      then(resolve, reject) {
        try {
          let result;
          if (operation === 'insert') {
            result = [{ id: `generated-${rows[table].length + 1}`, ...payload }]; rows[table].push(...result);
          } else {
            result = rows[table].filter(r => filters.every(f => f(r))).slice(0, limit);
            if (operation === 'update') result.forEach(r => Object.assign(r, payload));
          }
          return Promise.resolve({ data: structuredClone(single ? result[0] ?? null : result), error: null }).then(resolve, reject);
        } catch (error) { return Promise.reject(error).then(resolve, reject); }
      },
    };
    return q;
  } };
}
function modules(client, principalEmail = 'staff@test.invalid') {
  const cache = new Map();
  const files = new Set(['lib/additionalCharges.ts', 'lib/identity.ts', 'lib/financials.ts', 'lib/financialMath.ts', 'lib/billApproval.ts', 'lib/paymentObligations.ts', 'lib/paymentAllocations.ts', 'lib/residentFinancialSummary.ts', 'lib/paymentReceiptPurpose.ts', 'app/api/payment-verification/route.ts']);
  function load(file) {
    assert.ok(files.has(file), `Unexpected executable module ${file}`);
    if (cache.has(file)) return cache.get(file);
    const exports = {};
    cache.set(file, exports);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    const localRequire = name => {
      if (name === '@/lib/supabase') return { supabase: client };
      if (name === '@/lib/supabaseAdmin') return { supabaseAdmin: client };
      if (name === 'next/server') return { NextResponse: { json: (body, options = {}) => ({ status: options.status ?? 200, body }) } };
      if (name === '@supabase/supabase-js') return { createClient: () => ({ auth: { getUser: async () => ({ data: { user: { email: principalEmail } }, error: null }) } }) };
      if (name === '@/lib/notifications/server') return { notifyResidentEvent: async () => ({ warning: null }) };
      assert.ok(name.startsWith('@/lib/') || name.startsWith('./'), `Unexpected import ${name}`);
      return load(`lib/${name.split('/').at(-1)}.ts`);
    };
    vm.runInNewContext(`(function(require,exports){${code}\n})`, {
      process: { env: { NEXT_PUBLIC_SUPABASE_URL: 'https://mock.invalid', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake' } },
    }, { timeout: 2000 })(localRequire, exports);
    return exports;
  }
  return load;
}
async function main() {
  const current = { id: 'current', resident_id: 'resident', status: 'Active', deposit_status: 'Pending', monthly_rent: 18000, security_deposit: 18000 };
  const old = { ...current, id: 'old', status: 'Completed', deposit_status: 'Held' };
  const bill = (id, type, admission_id = 'current') => ({ id, admission_id, resident_id: 'resident', bill_type: type, bill_status: 'Pending', total_amount: 18000, paid_amount: 0, balance_amount: 18000, rent_amount: type === 'Rent' ? 18000 : 0, due_date: null });
  const rows = { staff_users: [{ email: 'staff@test.invalid', role: 'Admin', status: 'Active' }], admissions: [current, old], bills: [bill('rent', 'Rent'), bill('deposit', 'Security Deposit'), bill('old-deposit', 'Security Deposit', 'old')], payments: [], payment_receipts: [], payment_allocations: [] };
  const load = modules(database(rows));
  const { POST } = load('app/api/payment-verification/route.ts');
  const { refreshBillFinancials } = load('lib/financials.ts');
  const { buildResidentFinancialSummary } = load('lib/residentFinancialSummary.ts');
  const snapshot = () => buildResidentFinancialSummary({ admission: current, room: null, bed: null, bills: rows.bills, payments: rows.payments });
  const receipt = (id, bill_id, amount, purpose, admission = 'current') => {
    const r = { id, bill_id, resident_id: 'resident', amount, status: 'Pending Verification', payment_id: null, reference_number: null, notes: `Payment purpose: ${purpose}\nAdmission ID: ${admission}\nPayment method: Bank` };
    rows.payment_receipts.push(r); return r;
  };
  const act = (id, action = 'Verify') => POST({ headers: { get: () => 'Bearer fake' }, json: async () => ({ receiptId: id, action, rejectionReason: 'Test rejection' }) });
  receipt('rent-partial', 'rent', 8000, 'Rent');
  assert.equal(snapshot().totalOutstanding, 36000, 'pending proof gives no credit');
  assert.equal((await act('rent-partial')).status, 200);
  assert.equal(snapshot().monthlyRentDue, 10000); assert.equal(snapshot().depositBalance, 18000);
  assert.equal(current.deposit_status, 'Pending'); assert.equal(old.deposit_status, 'Held');
  assert.equal((await act('rent-partial')).body.alreadyProcessed, true);
  assert.equal(rows.payments.length, 1);
  receipt('deposit-partial', 'deposit', 5000, 'Security Deposit');
  assert.equal((await act('deposit-partial')).status, 200);
  assert.equal(snapshot().depositBalance, 13000); assert.equal(snapshot().monthlyRentDue, 10000);
  assert.equal(current.deposit_status, 'Pending');
  receipt('deposit-rest', 'deposit', 13000, 'Security Deposit');
  assert.equal((await act('deposit-rest')).status, 200); assert.equal(current.deposit_status, 'Held');
  const reversed = rows.payments.find(p => p.id === rows.payment_receipts.find(r => r.id === 'deposit-rest').payment_id);
  reversed.payment_status = 'Cancelled';
  assert.equal(snapshot().depositBalance, 13000, 'ledger reverses credit before cached status refresh');
  await refreshBillFinancials('deposit');
  assert.equal(current.deposit_status, 'Pending'); assert.equal(old.deposit_status, 'Held');
  assert.equal((await act('deposit-rest')).status, 409, 'cancelled payment cannot be reverified through old proof');
  receipt('rejected', 'rent', 1000, 'Rent');
  const beforeReject = snapshot().totalOutstanding;
  assert.equal((await act('rejected', 'Reject')).status, 200);
  assert.equal(snapshot().totalOutstanding, beforeReject);
  for (const [id, target, purpose, admission] of [['combined', 'rent', 'Rent + Security Deposit', 'current'], ['wrong-purpose', 'rent', 'Security Deposit', 'current'], ['old-proof', 'old-deposit', 'Security Deposit', 'old'], ['wrong-admission', 'rent', 'Rent', 'old']]) {
    receipt(id, target, 1000, purpose, admission);
    const before = rows.payments.length;
    assert.equal((await act(id)).status, 409, id);
    assert.equal(rows.payments.length, before);
  }
  for (const p of rows.payments.filter(p => p.bill_id === 'deposit')) p.payment_status = 'Cancelled';
  rows.bills.find(b => b.id === 'deposit').bill_status = 'Cancelled';
  await refreshBillFinancials('deposit');
  assert.equal(snapshot().depositBalance, 18000); assert.equal(current.deposit_status, 'Pending');
  const depositState = current.deposit_status;
  rows.payments.find(p => p.bill_id === 'rent').payment_status = 'Cancelled';
  await refreshBillFinancials('rent');
  assert.equal(snapshot().monthlyRentDue, 18000); assert.equal(current.deposit_status, depositState);
  assert.equal(old.deposit_status, 'Held');
  rows.bills.push(bill('replacement-deposit', 'Security Deposit'));
  rows.payments.push({ id: 'replacement-payment', bill_id: 'replacement-deposit', resident_id: 'resident', amount: 18000, payment_status: 'Verified' });
  await refreshBillFinancials('deposit');
  assert.equal(current.deposit_status, 'Held', 'refreshing a cancelled bill preserves a paid replacement deposit');
  assert.equal(snapshot().depositBalance, 0);
  assert.equal(old.deposit_status, 'Held');
  // Allocation-backed credits must require a Verified parent, including reversals.
  const ledger = { payments: [], payment_allocations: [] };
  const helper = modules(database(ledger))('lib/financials.ts').getVerifiedPaymentTotal;
  for (const status of ['Pending','Rejected','Cancelled','Unexpected','Verified']) {
    ledger.payments=[{id:'p',bill_id:'rent',amount:100,payment_status:status}];
    ledger.payment_allocations=[{payment_id:'p',bill_id:'rent',amount:100}];
    assert.equal(await helper('rent'),status==='Verified'?100:0,status);
  }
  ledger.payments.push({id:'legacy',bill_id:'rent',amount:25,payment_status:'Verified'});
  assert.equal(await helper('rent'),125,'single allocation and legacy each count once');
  assert.equal(await helper('rent','p'),25,'exclude edited payment from both sources');
  ledger.payments[0].payment_status='Cancelled';
  assert.equal(await helper('rent'),25,'cancellation removes retained allocation credit');
  ledger.payments[0]={id:'p',bill_id:null,amount:200,payment_status:'Verified'};
  ledger.payment_allocations.push({payment_id:'p',bill_id:'deposit',amount:100});
  assert.equal(await helper('rent'),125); assert.equal(await helper('deposit'),100);
  for(const principalEmail of ['a_min@test.invalid','a%min@test.invalid']) {
    const authRows={...rows,staff_users:[{email:'admin@test.invalid',role:'Admin',status:'Active'}]};
    const unauthorized=modules(database(authRows),principalEmail)('app/api/payment-verification/route.ts').POST;
    assert.equal((await unauthorized({headers:{get:()=> 'Bearer fake'},json:async()=>({receiptId:'any',action:'Verify'})})).status,403,principalEmail);
  }
  console.log('PASS real verification authorization rejects wildcard lookalike principals');
  console.log('PASS status-filtered allocation totals: all states, exclusions, legacy fallback, no double counting, combined, reversal');
  console.log('PASS real verification route with in-memory client: partial rent/deposit, final Held, rejection, idempotency, purpose/admission guards, combined blocked');
  console.log('PASS real financial refresh with in-memory client: deposit reversal, cancelled bill, rent reversal and old admission isolation');
}
main().catch(error => { console.error(error); process.exitCode = 1; });


