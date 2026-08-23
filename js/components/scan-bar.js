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
import { decodeImageData, hasNativeDetector } from "../lib/barcode-decode.js";
import { openModal, closeModal } from "../lib/modal-stack.js";

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

  // THE CAMERA BUTTON IS ALWAYS PRESENT NOW.
  //
  // It used to render only where window.BarcodeDetector existed, which meant
  // it silently did not exist on most devices this app is aimed at. Hadi
  // reported "I don't see the scanner" and he was describing exactly that: on
  // Chrome for Windows the button was never created. Checking his browser
  // confirmed it, and the platform picture is worse than one laptop --
  // BarcodeDetector ships on Chrome for Android and essentially nowhere else,
  // and Chrome on iOS is WebKit underneath, so Safari iOS and Chrome iOS share
  // the same gap. One of his three target platforms had a scanner.
  //
  // So: native detector when the browser has one (it is faster and reads more
  // symbologies), and the bundled EAN/UPC decoder everywhere else. A control
  // that quietly disappears is worse than one that appears and explains its
  // limits, because the first is indistinguishable from the feature not
  // existing.
  const camBtn = document.createElement("button");
  camBtn.className = "btn btn-secondary scan-cam";
  camBtn.type = "button";
  camBtn.style.cssText = compact
    ? "font-size:13px;padding:10px 12px;white-space:nowrap;"
    : "font-size:14px;padding:14px 16px;white-space:nowrap;";
  camBtn.textContent = "📷 Scan with camera";
  camBtn.addEventListener("click", () => openCamera({ onSubmit, input }));
  wrap.appendChild(camBtn);

  if (autofocus) setTimeout(() => input.focus(), 50);
  return {
    el: wrap,
    refocus: () => input.focus(),
    setPlaceholder: (text) => { input.placeholder = text; },
  };
}


/** The camera overlay. Kept in this module so both the warehouse screens and
 *  the product builder get the identical scanner rather than two of them. */
async function openCamera({ onSubmit, input }) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // environment = the rear camera on a phone. Ignored on a laptop, which
      // only has one, so the same request is correct on both.
      video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (err) {
    // Permission denied, no camera, or an insecure context. Say which, and
    // point at the path that still works rather than leaving a dead end.
    toast(
      `Camera unavailable (${err?.message || "permission denied"}). You can still type the code, or use a handheld scanner — it types the code and presses Enter.`,
      { type: "danger" }
    );
    input?.focus();
    return;
  }

  const overlay = document.createElement("div");
  overlay.className = "scan-cam-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Scan a barcode with the camera");
  overlay.innerHTML = `
    <div class="scan-cam-bar">
      <span class="scan-cam-title">Point the camera at the barcode</span>
      <button type="button" class="btn btn-secondary btn-sm" data-cancel>Cancel</button>
    </div>
    <div class="scan-cam-stage">
      <video playsinline muted></video>
      <div class="scan-cam-reticle" aria-hidden="true"></div>
    </div>
    <p class="scan-cam-hint" data-hint>Hold the barcode straight and fill the box. Nothing is sent anywhere — the read happens on this device.</p>
  `;

  const video = overlay.querySelector("video");
  const hint = overlay.querySelector("[data-hint]");
  video.srcObject = stream;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let stopped = false;
  let detector = null;
  if (hasNativeDetector()) {
    try { detector = new window.BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"] }); }
    catch { detector = null; }
  }

  // Batch 8A, and this one is the most consequential of the six.
  //
  // Releasing the camera used to depend on stop() being called, and stop() was
  // only called by the Cancel button, by Escape, or by a successful scan.
  // Navigating away with the scanner open therefore left the phone's CAMERA
  // RUNNING with no visible overlay -- a hot torch on a warehouse phone, and a
  // privacy indicator the user cannot account for.
  //
  // Camera release is now the modal stack's onClose, so it happens however the
  // dialog goes away, route change included.
  function stop() {
    if (stopped) return;
    closeModal(overlay);            // -> onClose below does the real teardown
  }
  function found(code) {
    stop();
    onSubmit(String(code).trim());
  }

  overlay.querySelector("[data-cancel]").addEventListener("click", stop);
  openModal(overlay, {
    label: "Scan a barcode",
    onClose: () => {
      stopped = true;
      stream.getTracks().forEach((t) => t.stop());
    },
  });

  try { await video.play(); } catch { /* autoplay policies; the loop copes */ }

  let misses = 0;
  async function tick() {
    if (stopped || !video.isConnected) return;
    const w = video.videoWidth, h = video.videoHeight;
    if (w && h) {
      if (detector) {
        try {
          const codes = await detector.detect(video);
          if (codes.length && codes[0].rawValue) { found(codes[0].rawValue); return; }
        } catch { detector = null; }   // fall through to the bundled decoder
      }
      if (!detector) {
        // Only the middle band is read. A barcode fills the reticle, and
        // decoding the whole frame every tick is wasted work on a phone --
        // this is the difference between a scanner that feels instant and one
        // that heats the device up.
        const bandH = Math.max(40, Math.floor(h * 0.35));
        const y0 = Math.floor((h - bandH) / 2);
        canvas.width = w; canvas.height = bandH;
        ctx.drawImage(video, 0, y0, w, bandH, 0, 0, w, bandH);
        try {
          const code = decodeImageData(ctx.getImageData(0, 0, w, bandH));
          if (code) { found(code); return; }
        } catch { /* keep trying */ }
      }
      misses++;
      // After a few seconds of not reading anything, say something useful
      // instead of letting the person conclude the feature is broken.
      if (misses === 90) {
        hint.textContent = "Not reading yet — try moving closer, steadying your hand, or turning on a light. You can also cancel and type the code.";
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}
