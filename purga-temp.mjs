import fs from 'fs';
const p=JSON.parse(fs.readFileSync("tracking.profiles.json","utf8"));
const prof=p.profiles[p.activeProfile];
const acc=prof.cloudflareAccountId, tok=prof.cloudflareApiToken, db=prof.d1DatabaseId;
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
async function q(sql){
  for(let i=0;i<25;i++){
    const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${acc}/d1/database/${db}/query`,{method:"POST",headers:{Authorization:`Bearer ${tok}`,"Content-Type":"application/json"},body:JSON.stringify({sql})});
    const j=await r.json();
    if(j.success) return j.result[0];
    const e=JSON.stringify(j.errors);
    if(/7429|971|Network/.test(e)){ await sleep(8000); continue; }
    throw new Error(e);
  }
  throw new Error("falhou apos varias tentativas");
}
const REMOVER="('page_view','time_on_page','video_progress','user_engagement')";
const [antes]=(await q(`SELECT COUNT(*) n FROM events WHERE event_name IN ${REMOVER}`)).results;
console.log("a remover:", antes.n.toLocaleString("pt-BR"), "linhas\n");

let total=0, rodada=0;
while(true){
  rodada++;
  const r=await q(`DELETE FROM events WHERE id IN (SELECT id FROM events WHERE event_name IN ${REMOVER} LIMIT 20000)`);
  const n=r.meta?.changes ?? 0;
  total+=n;
  if(rodada%10===0 || n===0) console.log("  lote", rodada, "-> total removido:", total.toLocaleString("pt-BR"));
  if(n===0) break;
  await sleep(1200);
}
console.log("\nREMOVIDO:", total.toLocaleString("pt-BR"), "linhas");
const [dep]=(await q(`SELECT COUNT(*) n FROM events`)).results;
console.log("events agora:", dep.n.toLocaleString("pt-BR"), "linhas");
