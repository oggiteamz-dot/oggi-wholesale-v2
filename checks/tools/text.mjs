// Dump what a screen actually renders, as text. For diagnosing "blank".
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const [ROLE, ...ROUTES] = process.argv.slice(2);
const PW="OggiDemo-2026";
const MIME={".html":"text/html",".css":"text/css",".js":"text/javascript",".json":"application/json",".woff2":"font/woff2",".png":"image/png",".svg":"image/svg+xml"};
const srv=createServer((q,s)=>{let p=decodeURIComponent(q.url.split("?")[0]);if(p==="/")p="/index.html";const f=join(ROOT,p);if(!existsSync(f)||f.endsWith("/")){s.writeHead(404);return s.end("nf");}s.writeHead(200,{"Content-Type":MIME[extname(f)]||"text/plain"});s.end(readFileSync(f));});
await new Promise(r=>srv.listen(0,r)); const BASE=`http://localhost:${srv.address().port}`;
const CRED={ owner:["Owner / Wholesaler","demo-owner@oggiwholesale.app"], wholesaler:["Owner / Wholesaler","demo-meridian@oggiwholesale.app"],
  sales:["Sales team","rep-meridian"], buyer:["Buyer","03 999 000"], warehouse:["Warehouse / Finance","wh-meridian"], finance:["Warehouse / Finance","fin-meridian"] };
const b=await chromium.launch(); const pg=await b.newPage({viewport:{width:1280,height:900}});
const net=[]; pg.on("response", async r=>{ const u=r.url(); if(/supabase\.co\/rest/.test(u)){
  let t=""; if(r.status()>=400){try{t=(await r.text()).slice(0,160);}catch{}}
  net.push(`${r.status()} ${decodeURIComponent(u.split("/rest/v1/")[1]).split("?")[0]}${t?" :: "+t:""}`);}});
pg.on("pageerror",e=>net.push("PAGEERROR "+e.message.slice(0,150)));
const [tab,u]=CRED[ROLE];
await pg.goto(BASE+"/#/login",{waitUntil:"networkidle"}); await pg.waitForTimeout(1000);
await pg.evaluate(t=>{const x=[...document.querySelectorAll("button")].find(y=>y.textContent.trim()===t);if(x)x.click();},tab);
await pg.waitForTimeout(700);
await pg.evaluate(({u,p,role})=>{const set=(e,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value");d.set.call(e,v);
    e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));};
  if(role==="warehouse"||role==="finance"){set(document.querySelector("#staff-wid"),"demo-meridian");set(document.querySelector("#staff-user"),u);set(document.querySelector("#staff-pass"),p);}
  else if(role==="sales"){set(document.querySelector("#sales-user"),u);set(document.querySelector("#sales-pass"),p);}
  else if(role==="buyer"){set(document.querySelector("#mkt-id"),u);set(document.querySelector("#mkt-pass"),p);}
  else {const vis=[...document.querySelectorAll("input")].filter(i=>i.offsetParent!==null);
    set(vis.find(i=>i.type==="email"||i.type==="text"),u);set(vis.find(i=>i.type==="password"),p);}
  [...document.querySelectorAll("button")].filter(x=>x.offsetParent!==null).find(x=>x.textContent.trim().toLowerCase()==="sign in").click();},{u,p:PW,role:ROLE});
await pg.waitForTimeout(5000);
await pg.evaluate(()=>{if(/Which one are you shopping/i.test(document.body.innerText)){const x=[...document.querySelectorAll("button")].find(y=>y.textContent.includes("Meridian"));if(x)x.click();}});
await pg.waitForTimeout(3500);
for (const route of ROUTES) {
  net.length=0;
  await pg.goto(BASE+"/#"+route,{waitUntil:"domcontentloaded"}); await pg.waitForTimeout(14000);
  const t = await pg.evaluate(()=>{const o=document.querySelector("#view-outlet")||document.body; return (o.innerText||"").replace(/\n{2,}/g,"\n").slice(0,700);});
  console.log(`\n===== ${route} =====\n${t}`);
  const notable=[...new Set(net)].filter(x=>/^[45]|PAGEERROR/.test(x));
  if(notable.length) console.log("  ⚠", notable.slice(0,4).join("\n  ⚠ "));
}
await b.close(); srv.close();
