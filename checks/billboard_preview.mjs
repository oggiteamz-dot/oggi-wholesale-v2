// Renders the billboard in its three shapes so they can be LOOKED at.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join, extname } from "node:path";
const ROOT = process.cwd(), PORT = 8261;
const MIME = { ".css":"text/css",".js":"text/javascript",".html":"text/html",".png":"image/png" };
const server = createServer(async (req,res)=>{ try{
  let p = decodeURIComponent(req.url.split("?")[0]); if(p==="/")p="/index.html";
  const f = join(ROOT,p); if(!f.startsWith(ROOT)){res.writeHead(403).end();return;}
  const b = await readFile(f);
  res.writeHead(200,{ "Content-Type": MIME[extname(f)]||"application/octet-stream" }); res.end(b);
}catch{res.writeHead(404).end();} });
await new Promise(r=>server.listen(PORT,r));

const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css">
<link rel="stylesheet" href="/css/components.css">
<style>body{background:var(--bg-page);padding:16px;font-family:var(--font-sans);max-width:900px;margin:0 auto}</style>
</head><body><div id="host"></div>
<script type="module">
import { renderBillboard, sectionHeader } from "/js/components/billboard.js";
const poster = "data:image/svg+xml;utf8," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675">' +
  '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
  '<stop offset="0" stop-color="#0E2230"/><stop offset="1" stop-color="#0A7D5A"/></linearGradient></defs>' +
  '<rect width="1200" height="675" fill="url(#g)"/>' +
  '<text x="70" y="300" font-family="Georgia,serif" font-size="86" fill="#fff">Summer 26</text>' +
  '<text x="70" y="372" font-family="Helvetica,sans-serif" font-size="34" fill="#9BE8C8">The linen drop is here</text>' +
  '</svg>');
const host = document.getElementById("host");
function label(t){ const h=document.createElement("p"); h.style.cssText="font-size:12px;color:#666;margin:24px 0 6px"; h.textContent=t; host.appendChild(h); }

label("1 — an advertisement for a product: poster plus a button");
host.appendChild(renderBillboard({url:poster, mediaType:"image", cta:"Shop the linen drop", onGo:()=>{}, label:"Summer 26"}));

label("2 — just a poster, no button");
host.appendChild(renderBillboard({url:poster, mediaType:"image", label:"Summer 26"}));

label("3 — the pinned group header, then the rest");
host.appendChild(sectionHeader("New Arrivals", 4));
const g=document.createElement("div");
g.style.cssText="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px";
["Linen Camp Shirt","Wide-Leg Trouser","Cropped Bomber","Ribbed Tank"].forEach(n=>{
  const c=document.createElement("div"); c.className="card"; c.style.cssText="padding:12px;font-size:13px"; c.textContent=n; g.appendChild(c);});
host.appendChild(g);
host.appendChild(sectionHeader("Everything else", 12));
<\/script></body></html>`;
await writeFile(join(ROOT, "checks/billboard_preview.html"), html);

const browser = await chromium.launch();
for (const [w,h,name] of [[900,1400,"billboard-desktop"],[390,1500,"billboard-mobile"]]) {
  const page = await browser.newPage({ viewport:{width:w,height:h} });
  const errs=[]; page.on("pageerror",e=>errs.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/checks/billboard_preview.html`, {waitUntil:"networkidle"});
  await page.waitForTimeout(700);
  await page.screenshot({ path:`checks/screenshots/${name}.png`, fullPage:true });
  console.log(name, "errors:", errs.length, errs[0]||"");
  await page.close();
}
await browser.close(); server.close();
