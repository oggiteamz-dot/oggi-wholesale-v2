// OGGI Wholesale v2 — the shared scan bar
//
// Lifted verbatim out of js/views/mobile-ops.js in Batch 16, where it had
// worked since Batch 10, so that the product builder can scan barcodes into
// grid cells without growing a second implementation. Extracted rather than
// copied on purpose: two scanners would drift, and the one in mobile-ops is
// the one that has actually been used against real hardware.
//
// SCANNING MECHANISM, restated here because it is the surprising part: the
// primary path is a plain autofocused text input. Nearly every warehouse
// barcode scanner presents itself as a fast keyboard that types the code and
// then presses Enter -- so an input that submits on Enter and refocuses itself
// works with any such device, with no camera, no library and no permission
// prompt. The camera button is progressive enhancement layered on top: it
// appears only where the browser exposes the native BarcodeDetector API, and
// its absence costs nothing because the keyboard path is the real one.
//
// autofocus is right for the warehouse screens (the operator's next action is
// always "scan the next thing") and wrong for a form where the scan bar is one
// field among many and stealing focus would fight the person filling it in --
// hence the `autofocus` option, defaulting to the historical true so the
// mobile-ops screens keep behaving exactly as they did.

import { toast } from "./toast.js";

/** Returns { el, refocus, setPlaceholder }. onSubmit receives the trimmed
 *  code; the input clears itself first, so a handler that throws cannot leave
 *  a half-typed code behind to be scanned again. */
export function renderScanBar({ placeholder, onSubmit, autofocus = true, compact = false }) {
  const wrap = document.createElement("div");
  wrap.className = compact ? "scan-bar scan-bar-compact" : "card scan-bar";
  wrap.style.cssText = compact
    ? "display:flex;gap:8px;align-items:center;"
    : "padding:14px;margin-bottom:16px;display:flex;gap:8px;align-items:center;";

  const input = document.createElement("input");
  input.className = "input";
  input.type = "text";
  input.placeholder = placeholder;
  input.autocomplete = "off";
  input.style.cssText = compact
    ? "flex:1;font-size:15px;padding:10px;"
    : "flex:1;font-size:18px;padding:14px;";
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && input.value.trim()) {
      // Enter inside a <form> would submit the whole product; the scan bar
      // lives inside one now that the builder uses it.
      e.preventDefault();
      const code = input.value.trim();
      input.value = "";
      onSubmit(code);
    }
  });
  wrap.appendChild(input);

  // Progressive enhancement only -- never assumed present.
  if (typeof window !== "undefined" && "BarcodeDetector" in window) {
    const camBtn = document.createElement("button");
    camBtn.className = "btn btn-secondary";
    camBtn.type = "button";
    camBtn.style.cssText = compact
      ? "font-size:13px;padding:10px 12px;white-space:nowrap;"
      : "font-size:14px;padding:14px 16px;white-space:nowrap;";
    camBtn.textContent = "📷 Scan";
    camBtn.addEventListener("click", async () => {
      try {
        const detector = new window.BarcodeDetector();
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        const video = document.createElement("video");
        video.srcObject = stream;
        video.setAttribute("playsinline", "true");
        video.style.cssText = "position:fixed;inset:0;width:100%;height:100%;object-fit:cover;z-index:9999;background:#000;";
        document.body.appendChild(video);
        await video.play();
        const stop = () => { stream.getTracks().forEach((t) => t.stop()); video.remove(); };
        video.addEventListener("click", stop);
        const tick = async () => {
          if (!video.isConnected) return;
          try {
            const codes = await detector.detect(video);
            if (codes.length) { stop(); onSubmit(codes[0].rawValue); return; }
          } catch { /* keep trying until stopped */ }
          requestAnimationFrame(tick);
        };
        tick();
      } catch (err) {
        toast("Camera scan unavailable (" + (err?.message || "permission denied") + ") — use the keyboard/scanner input instead", { type: "danger" });
      }
    });
    wrap.appendChild(camBtn);
  }

  if (autofocus) setTimeout(() => input.focus(), 50);
  return {
    el: wrap,
    refocus: () => input.focus(),
    setPlaceholder: (text) => { input.placeholder = text; },
  };
}
