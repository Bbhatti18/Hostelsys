const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const {renderToStaticMarkup} = require('react-dom/server');
const source = fs.readFileSync('app/payment-verification/page.tsx','utf8');
// Render the actual summary JSX, without mounting auth, data fetching or actions.
const start = source.indexOf('{followupBills.filter');
const end = source.indexOf('{extra &&',start);
assert.ok(start > 0 && end > start);
const jsx = source.slice(start,end);
const code = ts.transpileModule('module.exports = ({followupBills,receipt,paymentAllocationRows,bills,money,firstText,text,displayStatus}) => <>'+jsx+'</>', {
  compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS}
}).outputText;
const mod = {exports:{}};
vm.runInNewContext('(function(require,module,exports){'+code+'})',{})(require,mod,mod.exports);
function render(status,combined=false,cancelled=false){
  const receipt={payment_id:'payment',id:'receipt',bill_id:combined?null:'deposit',amount:3000,status};
  const deposit={bill_id:'deposit',purpose:'Security Deposit',original:10000,verified:status==='Verified'?10000:7000,remaining:status==='Verified'?0:3000,followups:[{receipt_id:'receipt',amount:3000,due_date:'2026-11-04',note:'financial issue'}]};
  const rent={bill_id:'rent',purpose:'Rent',original:17000,verified:status==='Verified'?17000:0,remaining:status==='Verified'?0:17000,followups:[]};
  return renderToStaticMarkup(mod.exports({displayStatus:r=>cancelled?'Cancelled':r.status,receipt,followupBills:[deposit,rent],paymentAllocationRows:combined?[{bill_id:'deposit',amount:3000},{bill_id:'rent',amount:17000}]:[],bills:[{id:'rent',billing_month:'2026-10'}],money:n=>'Rs '+Number(n).toLocaleString('en-US'),text:v=>String(v??''),firstText:(row,keys)=>keys.map(k=>row?.[k]).find(Boolean)||''}));
}
for(const status of ['Verified','Pending Verification','Rejected','Cancelled']){
  const html=render(status);
  assert.doesNotMatch(html,/obligation|allocation|Verified excluding|Submitted to|projected remaining|Resident commitment|Current remaining/i);
  assert.match(html,/Total Deposit: Rs 10,000/);
  assert.match(html,/Previously Verified: Rs 7,000/);
  assert.match(html,/This Payment: Rs 3,000/);
  assert.match(html,/Payment Plan: Rs 3,000 due by 04 Nov 2026/);
  assert.match(html,/<p>Reason: financial issue<\/p>/);
  if(status==='Pending Verification'){
    assert.match(html,/Balance After Verification: Rs 0/);
    assert.doesNotMatch(html,/Remaining Balance/);
  }else{
    assert.match(html,new RegExp('Remaining Balance: Rs '+(status==='Verified'?'0':'3,000')));
    assert.doesNotMatch(html,/Balance After Verification/);
  }
}
const combined=render('Verified',true);
assert.match(combined,/Security Deposit<\/h4>/);
assert.match(combined,/Rent — October 2026<\/h4>/);
assert.match(combined,/Total Rent: Rs 17,000/);
assert.match(combined,/Previously Verified: Rs 0/);
assert.match(combined,/This Payment: Rs 17,000/);
assert.equal((combined.match(/Remaining Balance: Rs 0/g)||[]).length,2);
console.log('PASS Payment Verification summary: simple labels, status-aware unchanged amounts, independent combined bills, payment plan and reason.');

const helper={exports:{}};
vm.runInNewContext('(function(module,exports){'+ts.transpileModule(fs.readFileSync('lib/receiptDisplayStatus.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText+'})',{})(helper,helper.exports);
const {receiptDisplayStatus}=helper.exports;
for(const status of ['Verified','Pending Verification','Rejected']){
 const r={status,payment_id:'p'};
 assert.equal(receiptDisplayStatus(r,[{id:'p',payment_status:'Cancelled'}]),'Cancelled');
 assert.equal(receiptDisplayStatus(r,[{id:'p',payment_status:'Verified'}]),status);
 assert.equal(r.status,status);
}
assert.match(render('Verified',true,true),/Previously Verified: Rs 10,000/);
const React=require('react');
function page(status,filter='All',paymentStatus='Cancelled'){
 let index=0;const r={id:'r',resident_id:'resident',payment_id:'p',bill_id:null,status,amount:24000,created_at:'2026-10-05T00:00:00Z'};
 const states={1:[r],2:[{id:'resident',full_name:'Resident'}],3:[{id:'p',payment_status:paymentStatus}],8:filter,9:false};
 const deps={'react':{...React,useState(v){const i=index++;return [i in states?states[i]:v,()=>{}];},useEffect(){},useMemo:f=>f(),useCallback:f=>f},'react/jsx-runtime':require('react/jsx-runtime'),'@/lib/receiptDisplayStatus':helper.exports};
 const m={exports:{}};
 const req=id=>deps[id]||new Proxy({},{get:(_,key)=>key==='ADDITIONAL_CATEGORIES'?[]:key==='default'?()=>null:()=>null});
 vm.runInNewContext('(function(require,module,exports){'+ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText+'})',{})(req,m,m.exports);
 return renderToStaticMarkup(m.exports.default());
}
const cancelledPage=page('Verified','Cancelled');
assert.match(cancelledPage,/Receipt Verification: Verified/);
assert.match(cancelledPage,/Payment Status: Cancelled/);
assert.doesNotMatch(cancelledPage,/>Verify<|>Reject</);
assert.match(page('Pending Verification'),/Payment Status: Cancelled/);
assert.doesNotMatch(page('Verified','Verified'),/Receipt Verification: Verified/);
assert.match(cancelledPage,/>Verified<\/p><p[^>]*>0<\/p>/);
assert.match(cancelledPage,/>Cancelled<\/p><p[^>]*>1<\/p>/);
assert.match(page('Verified','All','Verified'),/>Verified<\/p><p[^>]*>1<\/p>/);
assert.match(page('Pending Verification','All','Pending'),/>Verify<\/button>/);
assert.match(page('Pending Verification','All','Pending'),/>Reject<\/button>/);
assert.match(page('Rejected','All','Rejected'),/>Rejected<\/p><p[^>]*>1<\/p>/);
assert.match(source,/displayStatus\(item\) === "Verified"/);
assert.match(source,/displayStatus\(receipt\) !== "Pending Verification"/);
const paymentsSource=fs.readFileSync('app/payments/page.tsx','utf8');
assert.doesNotMatch(paymentsSource,/Reconcile balance|balance reconciled/);
assert.match(paymentsSource,/payment.payment_status !== "Cancelled" && <button/);
console.log('PASS cancelled presentation: precedence, filters, summary wiring, historical verification, suppressed actions, combined receipts, and no reconciliation button.');
