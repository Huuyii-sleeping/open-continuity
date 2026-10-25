import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { rankEvidence } from "../../src/core/evidence-ranking.js";
import type { CandidateSearchResult, ScoredSearchHit } from "../../src/core/candidate-search.js";
import type { ResolvedMemory, RetrievalChannel } from "../../src/shared/types.js";
import { scoreRanking } from "../baseline/metrics.js";

// Fixed synthetic evidence-layer examples; public current/stale facts use core-baseline-v1 separately.
const cases = [
 { id:"native_order", exact:[], text:["focused","newer-noise"], structured:[], limit:1, relevant:["focused"], forbidden:["newer-noise"], bm25:true },
 { id:"exact_tier", exact:["user-exact","task-exact"], text:["text-only"], structured:[], limit:2, relevant:["user-exact","task-exact"], forbidden:["text-only"], bm25:false },
 { id:"rank_corroboration", exact:["corroborated"], text:["newer-noise","other-noise","corroborated"], structured:[], limit:1, relevant:["corroborated"], forbidden:["newer-noise","other-noise"], bm25:false },
 { id:"filter_not_evidence", exact:[], text:[], structured:["unrelated"], limit:2, relevant:[], forbidden:["unrelated"], bm25:false },
] as const;
const baseMemory = (id: string): ResolvedMemory => ({ id,key:id,value:"fictional evidence",kind:"decision",scope:"user",sensitivity:"public",userConfirmed:true,sourceEventId:`fictional-event-${id}`,sourceAgentId:"fictional-writer",updatedAt:id==="newer-noise"?"2032-01-01T00:00:00Z":"2031-01-01T00:00:00Z",version:1 });
function batch(channel:RetrievalChannel,ids:readonly string[],bm25:boolean):CandidateSearchResult {
 return {channel,status:"ok",truncated:false,implementation:bm25?"sqlite_fts5_bm25":"structured_lookup",ordering:bm25?"bm25_then_updated_at_id":"updated_at_id",
  hits:ids.map((id,i):ScoredSearchHit=>({memory:baseMemory(id),channel,channelRank:i+1,rankMeaning:bm25?"relevance":channel==="structured"?"filter_order":"match_order",
   score:bm25?{model:"fts5_bm25",value:-10+i,direction:"lower_is_better"}:{model:"none",value:null,direction:"not_applicable"},
   match:{type:channel==="exact"?"exact_key":channel==="structured"?"structured_filter":"literal_substring",reason:channel==="exact"?"key_equals":channel==="structured"?"explicit_filters":"literal_contains",filters:[]}}))};
}
const variants=["default","without_exact_precedence","without_rrf","without_bm25"] as const;
try {
 const {values}=parseArgs({options:{"report-dir":{type:"string"}},strict:true});
 const directory=values["report-dir"]?resolve(values["report-dir"]):mkdtempSync(join(tmpdir(),"oc-fictional-ranking-report-"));
 // A supplied directory must be new; refuse to overwrite evidence.
 if(values["report-dir"])mkdirSync(directory,{recursive:false});
 const rows=[];
 for(const scenario of cases)for(const variant of variants){
  const batches=[batch("exact",scenario.exact,false),batch("full_text",scenario.text,scenario.bm25),batch("structured",scenario.structured,false)];
  if(variant==="without_bm25")for(const b of batches)if(b.ordering==="bm25_then_updated_at_id"){
   b.hits.sort((a,c)=>c.memory.updatedAt.localeCompare(a.memory.updatedAt)||c.memory.id.localeCompare(a.memory.id));
   b.hits.forEach((h,i)=>{h.channelRank=i+1;h.rankMeaning="match_order";h.score={model:"none",value:null,direction:"not_applicable"};});
   b.ordering="updated_at_id";b.implementation="sqlite_literal_fallback";
  }
  // Isolate RRF's contribution by disabling exact tier in both arms of this one scenario.
  const policy={rrfK:60,exactPrecedence:scenario.id!=="rank_corroboration"&&variant!=="without_exact_precedence",fusion:variant==="without_rrf"?"best_rank" as const:"rrf" as const};
  const results=Array.from({length:5},()=>rankEvidence(batches,policy));
  const selected=results[0]!.slice(0,scenario.limit).map(x=>x.memory.id);
  const ranking=scoreRanking(selected,{relevant:[...scenario.relevant],forbidden:[...scenario.forbidden]},[1,3,5]);
  rows.push({id:scenario.id,variant,policy,limit:scenario.limit,judgment:{relevant:scenario.relevant,forbidden:scenario.forbidden},selected,
   ranking,passed:ranking.miss.numerator===0&&ranking.falseSelection.numerator===0,stable:results.every(r=>JSON.stringify(r)===JSON.stringify(results[0])),evidence:results[0]!.map(r=>({memoryId:r.memory.id,...r.retrieval}))});
 }
 const passed=rows.filter(r=>r.variant==="default").every(r=>r.passed&&r.stable);
 const fingerprint=createHash("sha256").update(JSON.stringify(cases)).digest("hex");
 const sourceHash=createHash("sha256").update(readFileSync(new URL("../../src/core/evidence-ranking.ts",import.meta.url))).digest("hex");
 for(const [name,value]of Object.entries({quality:{passed,datasetFingerprint:fingerprint,sourceHash,rows:rows.filter(r=>r.variant==="default")},ablation:{rows:rows.filter(r=>r.variant!=="default"),note:"controlled evidence-layer signal isolation; not end-to-end quality or performance evidence"},stability:{rows:rows.map(r=>({id:r.id,variant:r.variant,stable:r.stable,repeats:5})),note:"same evidence repeated; database rebuild stability in public baseline"}}))writeFileSync(join(directory,`${name}.json`),JSON.stringify(value,null,2),{flag:"wx",mode:0o600});
 process.stdout.write(JSON.stringify({passed,cases:cases.length,variants:variants.length,datasetFingerprint:fingerprint,reportDirectory:directory}) + "\n");
 if(!passed)process.exitCode=1;
}catch(error){console.error(`Ranking evaluation failed: ${error instanceof Error?error.name:"unknown"}`);process.exitCode=1;}
