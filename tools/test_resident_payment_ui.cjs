// Render the real resident card with isolated state. No database, network, or files written.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const source=fs.readFileSync('components/payments/PaymentFollowups.tsx','utf8');
const row=(id,purpose,remaining,available=remaining)=>({bill_id:id,admission_id:'current',resident:'Resident',purpose,billing_month:'2026-10',original:remaining,verified:0,pending:remaining-available,remaining,available,followups:[],pending_receipts:[]});
const rows=[row('rent','Rent',17000),row('deposit','Security Deposit',10000)];
const helperModule={exports:{}};vm.runInNewContext('(function(require,module,exports){'+ts.transpileModule(fs.readFileSync('lib/paymentSubmissionPreview.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText+'})',{})(()=>({roundMoney:n=>Math.round((n+Number.EPSILON)*100)/100}),helperModule,helperModule.exports);
const {paymentSubmissionPreview}=helperModule.exports;
assert.equal(paymentSubmissionPreview(10000,7000,3000).financialBalance,10000);
assert.equal(paymentSubmissionPreview(10000,7000,3000).available,3000);
assert.equal(paymentSubmissionPreview(10000,7000,3000).projectedAvailableRemainder,0);
assert.equal(paymentSubmissionPreview(10000,7000,3000).requiresCommitment,false);
assert.equal(paymentSubmissionPreview(10000,7000,2000).projectedAvailableRemainder,1000);
assert.equal(paymentSubmissionPreview(10000,7000,3001).exceedsAvailable,true);
function render(purpose,amounts={},against='current',customRows=rows,overrides={}){
 let index=0;const changed={},submissions=[];const states={0:purpose,1:customRows,3:amounts,15:against,...overrides};
 const mockReact={...React,useState(initial){const key=index++;return [key in states?states[key]:initial,value=>{changed[key]=value;}];},useEffect(){},useCallback:f=>f};
 const deps={'react':mockReact,'react/jsx-runtime':require('react/jsx-runtime'),'next/link':({children,...props})=>React.createElement('a',props,children),'@/lib/supabase':{supabase:{auth:{getSession:async()=>({data:{session:{access_token:'local-test'}}})},rpc:async()=>({data:customRows,error:null})}},'@/lib/paymentSubmissionPreview':helperModule.exports,'@/lib/financialMath':{roundMoney:n=>Math.round(n*100)/100}};
 const module={exports:{}};const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,esModuleInterop:true,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2020}}).outputText;
 vm.runInNewContext('(function(require,module,exports){'+code+'\n})',{Date,Object,Number,Math,FormData,Event,window:{dispatchEvent(){}},fetch:async(url,options)=>{submissions.push(options.body);return {ok:true,json:async()=>({message:'Submitted'})};}})(id=>{assert.ok(deps[id],id);return deps[id];},module,module.exports);
 const tree=module.exports.default({additionalPaymentForm:React.createElement('form',{'data-testid':'combined-extra'},React.createElement('input',{required:true,type:'file'}))});
 return {tree,changed,submissions,html:renderToStaticMarkup(tree)};
}
function nodes(tree,type){if(!tree||typeof tree!=='object')return [];return [...(tree.type===type?[tree]:[]),...React.Children.toArray(tree.props?.children).flatMap(child=>nodes(child,type))];}
const forbidden=/canonical obligation|staff classification required|evidence only|non-ledger|Available to submit now|Pay an Obligation/i;
for(const [purpose,amounts,against] of [['rent',{rent:'17000'},'current'],['deposit',{deposit:'7000'},'current'],['combined',{rent:'17000',deposit:'7000'},'current'],['other',{},'other'],['historical',{},'historical']]){
 const view=render(purpose,amounts,against);assert.match(view.html,/Make a Payment/);assert.doesNotMatch(view.html,forbidden);assert.equal(nodes(view.tree,'form').length,1);const files=nodes(view.tree,'input').filter(n=>n.props.type==='file');assert.equal(files.length,1);assert.equal(files[0].props.required,true);assert.match(view.html,/Submit for Verification/);
}
assert.match(render('rent',{rent:'17000'}).html,/October 2026/);
assert.doesNotMatch(render('rent',{rent:'17000'}).html,/When will you pay/);
assert.match(render('deposit',{deposit:'7000'}).html,/Amount still available to pay after this submission: Rs 3,000/);
assert.match(render('combined',{rent:'17000',deposit:'7000'}).html,/Rs 24,000/);
const initial=render('');const purposeSelect=nodes(initial.tree,'select')[0];assert.ok(nodes(initial.tree,'option').some(n=>n.props.value==='combined:rent:deposit'));
assert.match(initial.html,/Rent — October 2026 \+ Security Deposit — Rs 27,000/);
purposeSelect.props.onChange({target:{value:'combined:rent:deposit'}});assert.deepEqual(JSON.parse(JSON.stringify(initial.changed[3])),{rent:'17000',deposit:'10000'});
const history=render('');nodes(history.tree,'select')[0].props.onChange({target:{value:'historical'}});assert.equal(history.changed[15],'historical');assert.deepEqual(Object.keys(history.changed[3]),[]);
const pending=render('deposit',{deposit:''},'current',[row('deposit','Security Deposit',7000,0)]);assert.match(pending.html,/awaiting review|Awaiting verification/);assert.equal(nodes(pending.tree,'button').find(n=>n.props.type==='submit').props.disabled,true);
const extra=render('additional');assert.equal(nodes(extra.tree,'form').length,1);assert.equal(nodes(extra.tree,'form')[0].props['data-testid'],'combined-extra');
const page=fs.readFileSync('app/resident-portal/payments/page.tsx','utf8');assert.equal((page.match(/<PaymentFollowups\b/g)||[]).length,1);assert.equal((page.match(/<form onSubmit=\{uploadReceipt\}/g)||[]).length,1);assert.match(page,/additionalPaymentForm=\{/);assert.doesNotMatch(page,/<h2[^>]*>Upload Payment Receipt<\/h2>/);assert.match(source,/body\.set\("historical","true"\)/);assert.match(source,/if \(!file \|\| !method/);
console.log('PASS resident payment UX: friendly labels, one active form, required receipt, explicit flexible combined choice, partial fields, pending cap display, previous receipt routing and retained combined Additional Charges form');

const reserved=[row('rent','Rent',17000,0),row('deposit','Security Deposit',10000,3000)];
const filling=render('deposit',{deposit:'3000'},'current',reserved);
assert.match(filling.html,/Financial balance:.*Rs 10,000/);assert.match(filling.html,/Awaiting verification: Rs 7,000/);assert.match(filling.html,/Available to pay now: Rs 3,000/);
assert.match(filling.html,/Amount still available to pay after this submission: Rs 0/);assert.doesNotMatch(filling.html,/When will you pay|type="checkbox"/);
const smaller=render('deposit',{deposit:'2000'},'current',reserved);assert.match(smaller.html,/Amount still available to pay after this submission: Rs 1,000/);assert.match(smaller.html,/When will you pay/);
const combinedPending=render('combined',{rent:'12000',deposit:'3000'},'current',[row('rent','Rent',17000,12000),reserved[1]]);assert.doesNotMatch(combinedPending.html,/When will you pay/);
(async()=>{
 const submitted=render('deposit',{deposit:'3000'},'current',reserved,{4:'2026-11-04',5:'old note',6:true,7:'Bank Transfer',8:'reference',9:new File(['proof'],'proof.pdf',{type:'application/pdf'}),17:'2025-01-01',18:'100'});
 nodes(submitted.tree,'form')[0].props.onSubmit({preventDefault(){}});
 await new Promise(resolve=>setImmediate(resolve));
 for(const index of [0,4,5,7,8,17,18])assert.equal(submitted.changed[index],'');
 assert.deepEqual(JSON.parse(JSON.stringify(submitted.changed[3])),{});assert.equal(submitted.changed[6],false);assert.equal(submitted.changed[9],null);assert.equal(submitted.changed[15],'current');assert.equal(submitted.changed[16],'Previous Rent');assert.equal(submitted.changed[19](0),1);
 const multiple=[{...row('september','Rent',13000),billing_month:'2026-09'},row('october','Rent',13000),row('deposit','Security Deposit',13000)];
 const choices=render('',{},'current',multiple);assert.match(choices.html,/Rent — September 2026 — Rs 13,000/);assert.match(choices.html,/Rent — October 2026 — Rs 13,000/);assert.ok(!nodes(choices.tree,'option').some(n=>['rent','combined'].includes(n.props.value)));
 nodes(choices.tree,'select')[0].props.onChange({target:{value:'combined:october:deposit'}});assert.deepEqual(JSON.parse(JSON.stringify(choices.changed[3])),{october:'13000',deposit:'13000'});
 const exact=render('combined:october:deposit',{october:'13000',deposit:'13000'},'current',multiple,{7:'Bank',9:new File(['proof'],'proof.pdf',{type:'application/pdf'})});
 nodes(exact.tree,'form')[0].props.onSubmit({preventDefault(){}});await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(JSON.parse(exact.submissions[0].get('obligationItems')),[{bill_id:'october',amount:13000,purpose:'Rent',billing_month:'2026-10'},{bill_id:'deposit',amount:13000,purpose:'Security Deposit',billing_month:'2026-10'}]);
 nodes(choices.tree,'select')[0].props.onChange({target:{value:'rent:september'}});assert.deepEqual(JSON.parse(JSON.stringify(choices.changed[3])),{september:'13000'});
 nodes(choices.tree,'select')[0].props.onChange({target:{value:'combined:missing:deposit'}});assert.deepEqual(JSON.parse(JSON.stringify(choices.changed[3])),{});
 const paid=render('',{},'current',[multiple[1],{...multiple[2],remaining:0,available:0,verified:13000}]);assert.ok(!nodes(paid.tree,'option').some(n=>n.props.value==='deposit'||String(n.props.value).startsWith('combined:')));
 console.log('PASS exact separate Rent month options, explicit combined IDs/month payload, missing bill never substituted and paid Deposit excluded');
 console.log('PASS pending-aware preview: 10k financial / 7k pending / 3k available; 3k no commitment; 2k commits 1k; independent combined amounts; successful submission clears state and remounts file form');
})().catch(error=>{console.error(error);process.exitCode=1;});
