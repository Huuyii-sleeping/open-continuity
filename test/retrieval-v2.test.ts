import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataType, newDb } from "pg-mem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryStore, JsonFileStore } from "../src/core/memory-store.js";
import { MemoryService } from "../src/core/memory-service.js";
import { RetrievalPipeline } from "../src/core/retrieval.js";
import { recallInputSchema } from "../src/shared/types.js";
import { SqliteMemoryStore } from "../src/sqlite/sqlite-memory-store.js";
import { PostgresMemoryStore, type DatabasePool } from "../src/postgres/postgres-memory-store.js";
const cleanups: Array<()=>Promise<void>>=[];
afterEach(async()=>{vi.useRealTimers();for(const f of cleanups.splice(0))await f();});
const actor={userId:"fictional-ranking-user",agentId:"fictional-reader"};
async function runtime(backend: string,limit=50,confirmed=false){
 const dir=mkdtempSync(join(tmpdir(),"oc-fictional-ranking-v2-"));let pool:DatabasePool|undefined;
 let store: InMemoryStore|JsonFileStore|SqliteMemoryStore|PostgresMemoryStore;
 if(backend==="sqlite")store=new SqliteMemoryStore(join(dir,"fictional.db"));
 else if(backend==="json")store=new JsonFileStore(join(dir,"fictional.json"));
 else if(backend==="memory")store=new InMemoryStore();
 else {const db=newDb({autoCreateForeignKeyIndices:true});db.public.registerFunction({name:"pg_advisory_xact_lock",args:[DataType.integer],returns:DataType.integer,implementation:()=>1});db.public.registerFunction({name:"strpos",args:[DataType.text,DataType.text],returns:DataType.integer,implementation:(s:string,q:string)=>s.indexOf(q)+1});const adapter=db.adapters.createPg();pool=new adapter.Pool();store=new PostgresMemoryStore(pool!);}
 const service=new MemoryService(store,{candidateLimit:limit},{defaultTokenBudget:4096,maxTokenBudget:4096,maxMemories:10,requireUserConfirmed:confirmed});
 cleanups.push(async()=>{try{await service.close();await pool?.end?.();}finally{rmSync(dir,{recursive:true,force:true});}});
 const write=(key:string,value:string,extra:Partial<Parameters<MemoryService["remember"]>[0]>={})=>service.remember({...actor,key,value,kind:"decision",userConfirmed:true,idempotencyKey:key,...extra});
 return {store,service,write};
}
for(const backend of ["memory","json","sqlite","pg-mem"])describe(`public scored retrieval: ${backend}`,()=>{
 it("enforces private, scope, user and confirmation boundaries before budget for Context and Query",async()=>{
  const {service,write}=await runtime(backend,1,true);
  await write("approved","needle");
  await write("unconfirmed","needle",{userConfirmed:false});
  await write("private","needle",{sensitivity:"private"});
  await write("agent","needle",{scope:"agent",agentId:"fictional-other-agent"});
  await write("task","needle",{scope:"task",taskId:"fictional-other-task"});
  await write("user","needle",{userId:"fictional-other-user"});
  expect((await service.context({...actor,query:"needle"})).items.map(x=>x.key)).toEqual(["approved"]);
  const query=await service.query({...actor,query:"needle",strategy:"direct"});
  expect(query.evidence.map(x=>x.memory.key)).toEqual(["approved"]);
  expect(query.evidence[0]!.memory.retrieval).toMatchObject({scoreModel:"query_sum",rankingVersion:"core-ranking-v2"});
  expect(query.evidence[0]!.memory.retrieval?.evidence?.[0]).toMatchObject({query:"needle",stepId:"recall-1"});
  expect(query.evidence[0]!.memory.retrieval?.evidence).toHaveLength(1);
  const multi=await service.query({...actor,query:"needle",strategy:"multi_step",subqueries:["needle","approved"]});
  const signals=multi.evidence[0]!.memory.retrieval!.evidence!;
  expect(signals).toHaveLength(3);
  expect(new Set(signals.map(s=>s.query))).toEqual(new Set(["needle","approved"]));
  expect((await service.recall({...actor,query:"unconfirmed"})).memories[0]!.userConfirmed).toBe(false);
 });
 it("never pads a no-match query with structured-only records",async()=>{
  const {service,write}=await runtime(backend);await write("decision","unrelated");
  const result=await service.recall({...actor,query:"absent",kind:"decision"});
  expect(result.memories).toEqual([]);
  expect(result.retrieval?.channelResults?.find(b=>b.channel==="structured")).toMatchObject({candidateCount:1});
 });
 it("preserves channel positions and explains filter-only qualification without boost",async()=>{
  const {service,write}=await runtime(backend);await write("target","needle");await write("noise","unrelated");
  const result=await service.recall({...actor,query:"needle",kind:"decision"});
  expect(result.memories.map(x=>x.key)).toEqual(["target"]);
  const r=result.memories[0]!.retrieval!;expect(r.score).toBeCloseTo(1/61);
  expect(r.evidence?.find(e=>e.channel==="structured")?.contribution).toBe(0);
 });
 it("paginates a bounded ranked set and binds ranking parameters, identity and confirmation",async()=>{
  const {service,store,write}=await runtime(backend);for(let i=0;i<5;i++)await write(`record-${i}`,"needle");
  const first=await service.recall({...actor,query:"needle",limit:1});
  expect(first.nextCursor).toBeTruthy();
  const second=await service.recall({...actor,query:"needle",limit:100,cursor:first.nextCursor!});
  expect(new Set([...first.memories,...second.memories].map(m=>m.id)).size).toBe(5);
  const request=recallInputSchema.parse({...actor,query:"needle",limit:1,cursor:first.nextCursor!});
  for(const options of [{rrfK:10},{candidateLimit:2},{channels:["full_text"] as const},{exactPrecedence:false},{fusion:"best_rank" as const}]){
   await expect(new RetrievalPipeline(store,options).recall(request)).rejects.toMatchObject({code:"VALIDATION_ERROR"});
  }
  await expect(new RetrievalPipeline(store).recall(request,{requireUserConfirmed:true})).rejects.toMatchObject({code:"VALIDATION_ERROR"});
  await expect(service.recall({...actor,agentId:"fictional-other",query:"needle",cursor:first.nextCursor!})).rejects.toMatchObject({code:"VALIDATION_ERROR"});
  const legacy=JSON.parse(Buffer.from(first.nextCursor!,"base64url").toString());delete legacy.version;
  await expect(service.recall({...actor,query:"needle",cursor:Buffer.from(JSON.stringify(legacy)).toString("base64url")})).rejects.toMatchObject({code:"VALIDATION_ERROR"});
 });
 it("uses current versions and retains independent scope identities",async()=>{
  const {service,write}=await runtime(backend);await write("fact","oldneedle");
  await write("fact","newneedle",{idempotencyKey:"replacement",expectedVersion:1});
  expect((await service.recall({...actor,query:"oldneedle"})).memories).toEqual([]);
  const current=(await service.recall({...actor,query:"newneedle"})).memories[0]!;
  expect(current).toMatchObject({version:2,supersedes:{version:1}});
  await write("fact","newneedle",{scope:"task",taskId:"fictional-task",idempotencyKey:"task-fact"});
  expect((await service.recall({...actor,query:"newneedle",taskId:"fictional-task"})).memories).toHaveLength(2);
 });
});
it("exposes SQLite BM25 through public recall with exact native order and raw scores",async()=>{
 const {service,store,write}=await runtime("sqlite");vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2031-01-01"));
 await write("focused","needle needle needle");vi.setSystemTime(new Date("2032-01-01"));await write("diluted","needle "+"filler ".repeat(100));vi.useRealTimers();
 const native=await store.searchCandidates({...actor,channel:"full_text",query:"needle"});const recall=await service.recall({...actor,query:"needle"});
 expect(recall.memories.map(m=>m.id)).toEqual(native.hits.map(h=>h.memory.id));
 expect(recall.memories.map(m=>m.retrieval?.evidence?.[0]!.score)).toEqual(native.hits.map(h=>h.score));
 expect(recall.memories[0]!.key).toBe("focused");
});
it("keeps a custom legacy Store available without claiming scored capabilities",async()=>{
 const store=new InMemoryStore();const service=new MemoryService({appendRemember:i=>store.appendRemember(i),appendForget:(...a)=>store.appendForget(...a),history:i=>store.history(i),recall:i=>store.recall(i)});
 await service.remember({...actor,key:"legacy",value:"needle",kind:"decision",idempotencyKey:"legacy"});
 const result=await service.recall({...actor,query:"needle"});expect(result.memories).toHaveLength(1);expect(result.retrieval?.rankingVersion).toBeUndefined();
});
