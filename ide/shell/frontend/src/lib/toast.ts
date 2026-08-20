// Minimal global toast notification, used for menu/button actions that are
// intentionally not wired to a real backend yet (see FRONTEND_MOCKS.md) --
// gives every "mock" click real, visible feedback instead of either doing
// nothing or being disabled. Also fine for genuine success/error feedback
// from real actions. Dispatches a window CustomEvent; ToastHost.tsx renders it.
export type ToastTone = "info" | "success" | "error";
export type ToastPayload = { id: number; message: string; tone: ToastTone };

let seq = 0;

export function showToast(message: string, tone: ToastTone = "info") {
  seq += 1;
  window.dispatchEvent(new CustomEvent<ToastPayload>("tangent:toast", { detail: { id: seq, message, tone } }));
}

// Shorthand for "clickable, but this isn't wired to a real backend yet" --
// the standard reaction for mock buttons per FRONTEND_MOCKS.md.
export function notYetWired(feature: string) {
  showToast(`${feature} isn't wired up yet — frontend only for now.`, "info");
}
