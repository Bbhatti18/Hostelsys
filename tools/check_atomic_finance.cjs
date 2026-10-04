// Structural checks and independent concurrency model, NOT PostgreSQL execution.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const dir='supabase/migrations/';
const sql=fs.readFileSync(dir+'20260822210000_atomic_finance_and_exact_identity.sql','utf8');
const combined=fs.readFileSync(dir+'20260822160000_combined_payment_allocations.sql','utf8');
const correction=fs.readFileSync(dir+'20260822200000_finance_contract_security_corrections.sql','utf8');
const route=fs.readFileSync('app/api/payment-verification/route.ts','utf8');
assert.match(combined,/pg_advisory_xact_lock\(20260822, 2100\)/);
assert.match(combined,/transaction_isolation[\s\S]*read committed[\s\S]*40001/);
assert.match(sql,/before insert or update or delete on public\.%I for each statement/);
assert.match(sql,/array\['payments','payment_allocations','bills','payment_receipts','admissions'\]/);
for(const name of ['verify_payment_with_allocations','create_combined_payment_submission','reject_payment_with_allocations']) {
  assert.match(combined,new RegExp(`function public\\.${name}\\([\\s\\S]*?begin\\s+perform public\\.lock_financial_ledger\\(\\);`));
}
assert.match(correction,/function public\.cancel_payment_with_allocations\([\s\S]*?begin\s+perform public\.lock_financial_ledger\(\);/);
assert.match(sql,/obligation.amount > b.total_amount - public.effective_bill_paid\(b.id, new.id\)/);
assert.match(sql,/a.status not in \('Pending','Active'\)/);
assert.match(sql,/p.payment_status = 'Verified'[\s\S]*union all[\s\S]*not exists/);
assert.match(sql,/new.paid_amount := paid/);
assert.match(sql,/Combined payment must settle the exact current outstanding obligations/);
assert.match(sql,/function public.refresh_bill_financials[\s\S]*Finance permission is required[\s\S]*lock_financial_ledger/);
assert.match(fs.readFileSync('lib/financials.ts','utf8'),/rpc\("refresh_bill_financials"/);
for(const match of sql.matchAll(/create or replace function public\.(\w+)\([\s\S]*?\n\$\$;/g)) {
  assert.ok(sql.includes(`revoke all on function public.${match[1]}(`),`${match[1]} privileges`);
  if(/security definer/i.test(match[0]))assert.match(match[0],/set search_path = pg_catalog, public/);
}
assert.match(sql,/payments_z_refresh_bills after insert or update or delete/);
assert.match(sql,/Reverse the payment instead of editing finalized allocations/);
for(const name of ['verify_single_payment_receipt','reject_single_payment_receipt']) {
  assert.match(sql,new RegExp(`revoke all on function public\\.${name}\\([^;]+from public, anon, authenticated;`));
  assert.match(sql,new RegExp(`grant execute on function public\\.${name}\\([^;]+to service_role;`));
  assert.ok(route.includes(`rpc("${name}"`));
}
assert.doesNotMatch(route,/reservedBill|claimedReceipt|paymentPayload|\.update\(\{\s*paid_amount:/);
const migrations=fs.readdirSync(dir).filter(f=>f.endsWith('.sql')).sort();
const atomicIndex=migrations.indexOf('20260822210000_atomic_finance_and_exact_identity.sql');
assert.ok(atomicIndex>migrations.indexOf('20260822160000_combined_payment_allocations.sql'));
assert.ok(migrations.indexOf('20261004120000_payment_followups.sql')>atomicIndex);

// Simultaneous callers must serialize validation with write, never only a preflight.
async function model() {
  let gate=Promise.resolve(), payments=[];
  const paid=()=>payments.filter(p=>p.status==='Verified').reduce((n,p)=>n+p.amount,0);
  function write(id,amount,status) {
    const work=gate.then(async()=>{
      if(payments.some(p=>p.id===id))return false;
      if(amount>100-paid())return false;
      await Promise.resolve();
      payments.push({id,amount,status});return true;
    });gate=work.catch(()=>{});return work;
  }
  assert.deepEqual(await Promise.all([write('a',80,'Verified'),write('b',80,'Verified')]),[true,false]);
  assert.equal(paid(),80);
  assert.equal(await write('a',10,'Verified'),false,'duplicate identity cannot create second credit');
  assert.equal(await write('c',20,'Verified'),true,'partial remaining balance accepted');
  payments[0].status='Cancelled';assert.equal(paid(),20);
  assert.equal(await write('d',80,'Pending'),true);assert.equal(paid(),20);
  payments.find(p=>p.id==='d').status='Rejected';assert.equal(paid(),20);
  assert.equal(await write('e',80,'Verified'),true);
  console.log('PASS atomic finance structure and serialized concurrency model; real SQL locking/rollback still requires PostgreSQL tests');
}
model().catch(e=>{console.error(e);process.exitCode=1});
