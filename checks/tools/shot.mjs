// Screenshot a named set of routes, signed in as a role. Fast iteration tool:
// node checks/tools/shot.mjs <outDir> <role> <route> [route...]
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const [OUT, ROLE, ...ROUTES] = process.argv.slice(2);
const W = Number(process.env.W || 1280), H = Number(process.env.H || 900);
mkdirSync(OUT, { recursive: true });
const PW="OggiDemo-2026";
const MIME={".html":"text/html",".css":"text/css",".js":"text/javascript",".json":"application/json",".woff2":"font/woff2",".png":"image/png",".svg":"image/svg+xml"};
const srv=createServer((q,s)=>{let p=decodeURIComponent(q.url.split("?")[0]);if(p==="/")p="/index.html";const f=join(ROOT,p);if(!existsSync(f)||f.endsWith("/")){s.writeHead(404);return s.end("nf");}s.writeHead(200,{"Content-Type":MIME[extname(f)]||"text/plain"});s.end(readFileSync(f));});
await new Promise(r=>srv.listen(0,r)); const BASE=`http://localhost:${srv.address().port}`;
const CRED={ owner:["Owner / Wholesaler","demo-owner@oggiwholesale.app",PW],
             wholesaler:["Owner / Wholesaler","demo-meridian@oggiwholesale.app",PW],
             sales:["Sales team","rep-meridian",PW], buyer:["Buyer","03 999 000",PW],
             warehouse:["Warehouse / Finance","wh-meridian",PW], finance:["Warehouse / Finance","fin-meridian",PW] };
const b=await chromium.launch(); const pg=await b.newPage({viewport:{width:W,height:H},deviceScaleFactor:1});
const errs=[]; pg.on("pageerror",e=>errs.push(e.message.slice(0,140)));
pg.on("console",m=>{if(m.type()==="error")errs.push(m.text().slice(0,140));});
if (CRED[ROLE]) {
  const [tab,u,p]=CRED[ROLE];
  await pg.goto(BASE+"/#/login",{waitUntil:"networkidle"}); await pg.waitForTimeout(1000);
  await pg.evaluate(t=>{const x=[...document.querySelectorAll("button")].find(y=>y.textContent.trim()===t); if(x)x.click();},tab);
  await pg.waitForTimeout(700);
  await pg.evaluate(({u,p,role})=>{
    const set=(e,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value");d.set.call(e,v);
      e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));};
    if(role==="warehouse"||role==="finance"){ set(document.querySelector("#staff-wid"),"demo-meridian");
      set(document.querySelector("#staff-user"),u); set(document.querySelector("#staff-pass"),p); }
    else if(role==="sales"){ set(document.querySelector("#sales-user"),u); set(document.querySelector("#sales-pass"),p); }
    else if(role==="buyer"){ set(document.querySelector("#mkt-id"),u); set(document.querySelector("#mkt-pass"),p); }
    else { const vis=[...document.querySelectorAll("input")].filter(i=>i.offsetParent!==null);
      set(vis.find(i=>i.type==="email"||i.type==="text"),u); set(vis.find(i=>i.type==="password"),p); }
    [...document.querySelectorAll("button")].filter(x=>x.offsetParent!==null)
      .find(x=>x.textContent.trim().toLowerCase()==="sign in").click();
  },{u,p,role:ROLE});
  await pg.waitForTimeout(5000);
  await pg.evaluate(()=>{ if(/Which one are you shopping/i.test(document.body.innerText)){
    const x=[...document.querySelectorAll("button")].find(y=>y.textContent.includes("Meridian")); if(x)x.click(); }});
  await pg.waitForTimeout(3500);
}
for (const route of ROUTES) {
  const prev = await pg.evaluate(()=>{const o=document.querySelector("#view-outlet")||document.body; return o.innerText||"";}).catch(()=>"");
  await pg.goto(BASE+"/#"+route,{waitUntil:"domcontentloaded"});
  await pg.evaluate(async (prev)=>{const o=()=>document.querySelector("#view-outlet")||document.body;
    let changed=false,last=-1,st=0;
    for(let i=0;i<50;i++){await new Promise(r=>setTimeout(r,300));const t=o().innerText||"";
      if(!changed){if(t!==prev)changed=true;else continue;}
      if(t.length===last&&t.length>0){if(++st>=2)return;}else{st=0;last=t.length;}}},prev);
  // Force lazy images to load. `loading="lazy"` images below the fold never
  // fetch in a headless run, so a catalogue screenshots as a wall of grey
  // boxes and looks broken when it is not. Documented in CLAUDE.md as having
  // cost real time once already.
  await pg.evaluate(async () => {
    document.querySelectorAll("img").forEach((i) => { i.loading = "eager"; if (i.dataset.src && !i.src) i.src = i.dataset.src; });
    await new Promise((r) => setTimeout(r, 2500));
  });
  await pg.waitForTimeout(500);
  const name=route.replace(/[^a-z0-9]+/gi,"_").replace(/^_|_$/g,"")||"root";
  await pg.screenshot({path:join(OUT,`${name}.png`)});
  console.log("  shot", route);
}
if(errs.length) console.log("  errors:", [...new Set(errs)].slice(0,3).join(" | "));
await b.close(); srv.close();
