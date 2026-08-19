// Renders the picker and a stand-in of the settings card so both can be LOOKED
// at. A previous batch shipped a thumbnail that landed below its row text and
// passed every assertion; only a screenshot found it.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join, extname } from "node:path";
const ROOT = process.cwd(), PORT = 8251;
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
<style>body{background:var(--bg-page);padding:16px;font-family:var(--font-sans)}</style>
</head><body><div id="settings"></div><div id="host"></div>
<script type="module">
import { renderProductPicker } from "/js/components/product-picker.js";
const sw=(c)=>"data:image/svg+xml;utf8,"+encodeURIComponent(\`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><rect width="120" height="160" fill="\${c}"/></svg>\`);

document.getElementById("settings").innerHTML = \`
<div class="card cat-settings">
  <div class="cat-settings-head"><h4>Summer 26 <span class="badge badge-neutral">Default</span></h4>
    <p>Who can see this catalog, and what it does to every price in it.</p></div>
  <div class="cat-settings-grid">
    <div><label>Customer tier</label>
      <select class="input"><option>Tier 1</option><option selected>Tier 2</option></select>
      <p class="cat-hint">Only customers you have set to tier 2 or above.</p></div>
    <div><label>Discount %</label><input class="input" type="number" value="-10">
      <p class="cat-hint">Customers pay 10% MORE than the price on each product.</p></div>
    <div class="cat-settings-mode"><label>When the customer has their own discount</label>
      <select class="input"><option selected>Combine both</option></select>
      <p class="cat-hint">This catalog's discount plus the customer's own. 5% here and 20% on them is 25% off.</p></div>
  </div>
  <p class="cat-hint cat-silent">Buyers never see this discount as a discount — the adjusted number is simply the price on the product. Only a customer's own rate is shown to them, struck through.</p>
  <div class="pf-actions"><button class="btn btn-primary btn-sm">Save catalog settings</button><span class="cat-hint">Saved.</span></div>
</div>\`;

const products = [
  {id:"p1",name:"Heavyweight Oversized Tee — Garment Dyed",variantCount:7,priceRange:[18,22],images:[sw("#B91C1C")],colors:[],variants:[]},
  {id:"p2",name:"Wide-Leg Denim Trouser",variantCount:9,priceRange:[30,30],images:[sw("#2F4A6B")],colors:[],variants:[]},
  {id:"p3",name:"Linen Camp Shirt",variantCount:4,priceRange:[0,0],images:[],colors:[],variants:[]},
  {id:"p4",name:"Ribbed Knit Cardigan",variantCount:5,priceRange:[24,26],images:[sw("#7C6A46")],colors:[],variants:[]},
  {id:"p5",name:"Cropped Bomber Jacket",variantCount:6,priceRange:[40,44],images:[sw("#3A3A3A")],colors:[],variants:[]},
];
const picker = renderProductPicker({products, alreadyIn:new Set(["p4"]), catalogName:"Summer 26",
  onAdd:async()=>{}, onClose:()=>{}});
document.body.appendChild(picker.el);
picker.el.querySelectorAll('.picker-row input[type=checkbox]')[0].click();
picker.el.querySelectorAll('.picker-row input[type=checkbox]')[1].click();
<\/script></body></html>`;
await writeFile(join(ROOT, "checks/catalog_builder_preview.html"), html);

const browser = await chromium.launch();
for (const [w,h,name,hidePicker] of [[390,900,"catalog-builder-mobile",false],[1280,900,"catalog-builder-desktop",false],[1280,700,"catalog-settings-desktop",true],[390,700,"catalog-settings-mobile",true]]) {
  const page = await browser.newPage({ viewport:{width:w,height:h} });
  const errs=[]; page.on("pageerror",e=>errs.push(e.message));
  page.on("console",m=>{ if(m.type()==="error") errs.push(m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/checks/catalog_builder_preview.html`, {waitUntil:"networkidle"});
  await page.waitForTimeout(900);
  if (hidePicker) { await page.evaluate(() => document.querySelector(".prod-edit")?.remove()); await page.waitForTimeout(200); }
  await page.screenshot({ path:`checks/screenshots/${name}.png`, fullPage:true });
  console.log(name, "errors:", errs.length, errs[0]||"");
  await page.close();
}
await browser.close(); server.close();
