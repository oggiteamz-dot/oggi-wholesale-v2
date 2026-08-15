// OGGI Wholesale v2 — AI-assisted catalog import from a photo/PDF (Batch 11)
//
// Real, working extraction -- NOT a mock -- once ANTHROPIC_API_KEY is set as
// a secret on this Supabase project. This build has no API key of its own
// to give the wholesaler, and hardcoding one here (or faking a response
// that pretends to be AI-extracted data) would be dishonest and unsafe, so
// this function checks for the secret at request time and returns a clear,
// actionable "not configured" response instead of ever fabricating rows.
// Once the wholesaler adds their own key (Project Settings -> Edge
// Functions -> Secrets -> ANTHROPIC_API_KEY), this endpoint works exactly
// as built, with no further code changes.
//
// verify_jwt is OFF, matching this entire build's dev-mode-until-Batch-14
// posture (the frontend calls Supabase with the anon/publishable key, no
// real Supabase Auth session exists yet) -- same category of "hardened for
// real in Batch 14" item as every v2_* table's permissive RLS policy.
//
// Input:  POST { imageBase64: string, mimeType: string }
// Output: { ok: true, rows: CsvImportRow[] } | { ok: false, reason, message }
// CsvImportRow shape matches js/data/csv-import.js's row schema exactly, so
// the frontend can feed AI-extracted rows through the SAME preview/dedupe/
// commit pipeline as a CSV upload -- one review-before-commit flow, not two.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const EXTRACTION_SYSTEM_PROMPT = `You are extracting a wholesale product catalog from a photo of a price list, a spec sheet, or a scanned/PDF catalog page.

Return ONLY a JSON array (no prose, no markdown fences) of objects with this exact shape:
[{"product_name": string, "sku": string, "color": string, "size": string, "price": number, "cost": number|null, "moq_qty": number|null, "barcode": string|null}]

Rules:
- One object per distinct SKU/variant you can identify (each colour+size combination is its own row).
- "sku" must be a real code visible in the image. If you cannot find a real SKU for a row, invent one deterministically from the product name + colour + size (e.g. "PRODUCTNAME-COLOR-SIZE") rather than leaving it blank -- every row needs a unique, non-empty sku.
- "price" must be a real number parsed from the image (strip currency symbols). If truly no price is visible for a row, omit that row entirely rather than guessing a number.
- Use null (not 0, not empty string) for any field you cannot determine, EXCEPT sku and price which are required.
- Do not invent products, colours, or sizes that are not actually shown in the image.
- If the image contains no readable product/pricing information at all, return an empty array: []`;

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({
        ok: false,
        reason: "not_configured",
        message: "AI-assisted import isn't set up yet. Add an ANTHROPIC_API_KEY secret to this Supabase project (Project Settings → Edge Functions → Secrets) to enable it. CSV import works right now without any extra setup.",
      }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
    }

    const { imageBase64, mimeType } = await req.json();
    if (!imageBase64 || !mimeType) {
      return new Response(JSON.stringify({ ok: false, reason: "bad_request", message: "Missing image data." }), {
        status: 200, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 4096,
        system: EXTRACTION_SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: [
            // PDFs use Anthropic's "document" content block (native PDF
            // understanding, not a rasterized-image workaround); photos use
            // "image" -- both real, both handled, not just images despite
            // the function's name.
            mimeType === "application/pdf"
              ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: imageBase64 } }
              : { type: "image", source: { type: "base64", media_type: mimeType, data: imageBase64 } },
            { type: "text", text: "Extract the product catalog from this document as the JSON array described in your instructions." },
          ],
        }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      return new Response(JSON.stringify({ ok: false, reason: "extraction_failed", message: `AI extraction request failed (${anthropicRes.status}): ${errText.slice(0, 300)}` }), {
        status: 200, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const result = await anthropicRes.json();
    const text = (result.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");

    let rows;
    try {
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      rows = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    } catch {
      return new Response(JSON.stringify({ ok: false, reason: "parse_failed", message: "The AI response wasn't valid JSON -- try a clearer photo, or use CSV import instead." }), {
        status: 200, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    if (!Array.isArray(rows)) {
      return new Response(JSON.stringify({ ok: false, reason: "parse_failed", message: "The AI response wasn't a list of products -- try a clearer photo, or use CSV import instead." }), {
        status: 200, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: true, rows }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, reason: "unexpected_error", message: String(err?.message || err) }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
