import { formatBytes } from "./file-utils.js";

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

export function statusLabel(status) {
  return String(status || "idle").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function renderQueueSummary(queue = []) {
  const active = queue.filter((item) => ["waiting", "starting", "in_progress"].includes(item.status)).length;
  const complete = queue.filter((item) => item.status === "completed").length;
  const failed = queue.filter((item) => item.status === "failed").length;
  return { active, complete, failed, label: active ? `${active} active` : failed ? `${failed} failed` : "Idle" };
}

export function selectedSize(items, selectedIds) {
  return items.reduce((total, item) => selectedIds.has(item.id) && item.sizeKnown ? total + item.sizeBytes : total, 0);
}

export { formatBytes };
