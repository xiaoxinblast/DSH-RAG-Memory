import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Budget, budgetCost, referenceCost, reserveCost, CANDIDATES, auditHistory, journalState } from "../../scripts/kernel-evaluation-budget.mjs";
import { checkWire } from "../../scripts/evaluate-kernel.mjs";
import { seed } from "../../scripts/kernel-evaluation.mjs";
import { extractionCases } from "../fixtures/extraction-cases-v6.mjs";

test("historical budget uses official upper bound, retains all 18 unknown reservations",()=>{
 const a=auditHistory();assert.equal(a.rounds.reduce((s,r)=>s+r.requests,0),4826);
 assert.equal(a.rounds.reduce((s,r)=>s+r.unknownCount,0),18);
 assert.ok(Math.abs(a.budgetPriorCny-5.0483462)<1e-8);assert.ok(Math.abs(a.unknownReserveCny-.3815136)<1e-8);
 assert.equal(a.corrections.length,12);
});
test("unknown usage remains fully reserved; pending requests cannot exceed ten yuan",()=>{
 const b=new Budget(9.8);assert.equal(b.reserve(.15),true);assert.equal(b.reserve(.1),false);
 assert.equal(b.settle(.15,null),.15);assert.ok(Math.abs(b.used-9.95)<1e-8);
 assert.equal(b.reserve(.06),false);assert.equal(b.reserve(.02),true);b.settle(.02,.01);
 assert.ok(Math.abs(b.used-9.96)<1e-8);assert.ok(Math.abs(b.pending)<1e-8);
});
test("settlement never loses charged usage exceeding a reservation",()=>{const b=new Budget(1);b.reserve(.1);b.settle(.1,.2);assert.equal(b.used,1.2);assert.equal(b.overrun,true);});
test("zero placeholder and interrupted responses cannot be priced as free",()=>{
 const c=CANDIDATES[2],p={httpStatus:200,finish:"stop",usage:{inputTokens:0,outputTokens:0}};
 assert.equal(budgetCost(p,c),null);p.usage.inputTokens=100;p.finish="error";assert.equal(budgetCost(p,c),null);
 p.finish="stop";assert.equal(budgetCost(p,c),.0002);p.usage.cacheReadTokens=1000;
 assert.equal(budgetCost(p,c),.0022);assert.deepEqual(referenceCost(p,c),{low:.00012,high:.00024});
});
test("wire guard refuses thinking, wrong model, tool payload and unexpected limits",()=>{
 for(const c of CANDIDATES){const b={model:c.model,temperature:0,max_tokens:2048,messages:Array.from({length:c.provider==="deepseek-account"?1:2},()=>({role:"user",content:"合成案例"})),enable_thinking:false};assert.equal(checkWire(b,c,"test").thinking,"off");
 for(const patch of [{model:"other"},{temperature:1},{max_tokens:4096},{enable_thinking:true},{tools:[{}]},{response_format:{type:"json_object"}}])assert.throws(()=>checkWire({...b,...patch},c,"test"));
 assert.ok(reserveCost(b,c)>0);}
});
test("journals reject repeat requests and identify unresolved phases without replay",()=>{
 const dir=mkdtempSync(join(tmpdir(),"memory-eval-")),file=join(dir,"journal.jsonl"),a={event:"phase-start",planId:"p",key:"task:extraction"};
 try{writeFileSync(file,JSON.stringify(a)+"\n");assert.deepEqual(journalState(file,"p").unresolved,[a.key]);assert.throws(()=>journalState(file,"other"));writeFileSync(file,JSON.stringify(a)+"\n"+JSON.stringify(a)+"\n");assert.throws(()=>journalState(file,"p"));}finally{rmSync(dir,{recursive:true});}
});
test("all synthetic fixtures seed in isolated memory and preserve existing forgotten status",async()=>{
 assert.equal(extractionCases.length,120);
 for(const f of extractionCases){const s=seed(f,CANDIDATES[0]);try{assert.equal(s.snapshot().length,f.existing.length);for(const old of f.existing)assert.equal(s.snapshot().find(m=>m.id===old.id).status,old.status);for(const src of f.sources)assert.equal(s.service.store.getSource(src.id).processed,0);}finally{await s.service.close();}}
});
