import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
const ROOT = process.cwd(), PORT = 8231;
const MIME = { ".css":"text/css",".js":"text/javascript",".html":"text/html",".woff2":"font/woff2",".png":"image/png",".json":"application/json" };
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
</head><body><div id="grid"></div><div id="panel" style="margin-top:24px"></div>
<script type="module">
import { renderProductTile, productGrid } from "/js/components/admin-product-tile.js";
import { renderProductDetail } from "/js/components/product-detail.js";
const sw=(c)=>"data:image/svg+xml;utf8,"+encodeURIComponent(\`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="300" height="400" fill="\${c}"/></svg>\`);
const g=productGrid();
[["Heavyweight Oversized Tee — Garment Dyed",["#B91C1C","#1E293B","#F5E9D7"],0,12,7],
 ["Ribbed Knit Cardigan",["#7C6A46"],40,40,4],
 ["Wide-Leg Denim Trouser",["#2F4A6B","#8FA6BF"],6,18,9],
 ["Silk Blend Scarf",[],0,0,2],
 ["Cropped Bomber Jacket",["#3A3A3A"],120,140,6],
 ["Linen Camp Shirt",["#DDE7DA","#C9B79C"],14,30,8]
].forEach(([n,cols,avail,onHand,vc],i)=>{
  const badges=[]; if(avail<=0)badges.push({text:"3 out",kind:"badge-danger"}); if(avail>0&&avail<15)badges.push({text:"2 low",kind:"badge-warning"});
  g.appendChild(renderProductTile({id:"p"+i,name:n,images:cols.map(sw),badges,
    facts:[{label:"Available",value:String(avail),tone:avail<=0?"danger":avail<=15?"warning":""},{label:"On hand",value:String(onHand)},{label:"Colours & sizes",value:String(vc)}],
    actions:[{label:"Receive & transfer",variant:"btn-primary",onClick:()=>{}},{label:"View",onClick:()=>{}},{label:"Edit",onClick:()=>{}}],
    onOpen:()=>{}}));
});
document.getElementById("grid").appendChild(g);
document.getElementById("panel").appendChild(renderProductDetail({ok:true,
 product:{id:"p1",name:"Heavyweight Oversized Tee",description:"240gsm, boxy fit.",category:"T-shirts",selling_model:"prepack",moq_qty:12,barcode:"5012345678900",archived:false},
 supplier:{name:"Zhejiang Textiles",contactName:"Wei Zhang",phone:"+86 555 0100",address:"12 Loom Rd",country:"China",sells:["knitwear","denim"],brands:["Loomcraft"],leadTime:"45 days",moq:"300 units",paymentTerms:"30% deposit",refCode:"ZJT-4"},
 images:[sw("#B91C1C"),sw("#1E293B"),sw("#F5E9D7")],
 colourBarcodes:[{color:"Crimson",barcode:"5012345678917"}],
 variants:[{id:"v1",sku:"TEE-CRI-M",colour:"Crimson",colourHex:"#B91C1C",size:"M",price:18.5,cost:7.25,retailPrice:45,moqQty:6,sizeBarcode:"5012345678924",colourBarcode:"5012345678917",stock:[{locationId:"l1",locationName:"Main warehouse",onHand:40,reserved:6,available:34},{locationId:"l2",locationName:"Showroom",onHand:5,reserved:0,available:5}],onHand:45,available:39},
  {id:"v2",sku:"TEE-NAV-M",colour:"Deep Navy",colourHex:"#1E293B",size:"M",price:18.5,cost:null,retailPrice:null,moqQty:6,sizeBarcode:"",colourBarcode:"",stock:[],onHand:0,available:0}],
 archivedVariantCount:1},{onEdit:()=>{},onClose:()=>{}}));
<\/script></body></html>`;

await (await import("node:fs/promises")).writeFile("checks/cards_preview.html", html);
const browser = await chromium.launch();
for (const [w,h,name] of [[390,900,"cards-mobile"],[1280,900,"cards-desktop"]]) {
  const page = await browser.newPage({ viewport:{width:w,height:h} });
  const errs=[]; page.on("pageerror",e=>errs.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/checks/cards_preview.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await page.screenshot({ path:`checks/screenshots/${name}.png`, fullPage:true });
  console.log(name, "errors:", errs.length, errs[0]||"");
  await page.close();
}
await browser.close(); server.close();
