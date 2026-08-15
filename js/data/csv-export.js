// OGGI Wholesale v2 — CSV export helper (Batch 5)
// Client-side only: fetch real data, format as CSV, trigger a browser
// download. No server-side export job needed at this scale.

function toCsvValue(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function rowsToCsv(rows, columns) {
  const header = columns.map((c) => c.label).join(",");
  const lines = rows.map((r) => columns.map((c) => toCsvValue(c.value(r))).join(","));
  return [header, ...lines].join("\n");
}

export function downloadCsv(filename, csvText) {
  const blob = new Blob([csvText], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
