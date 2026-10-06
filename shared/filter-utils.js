function splitExpressions(value) {
  return String(value || "").split(/[,;]/).map((part) => part.trim()).filter(Boolean);
}

function wildcardToRegExp(pattern, flags) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, flags);
}

export function compileExpression(value, mode = "plain", caseSensitive = false) {
  const parts = splitExpressions(value);
  const includes = [];
  const excludes = [];
  const flags = caseSensitive ? "" : "i";
  const errors = [];
  for (const raw of parts) {
    const negative = raw.startsWith("!");
    const source = negative ? raw.slice(1).trim() : raw;
    if (!source) continue;
    try {
      let matcher;
      if (mode === "regex") matcher = new RegExp(source, flags);
      else if (mode === "wildcard") matcher = wildcardToRegExp(source, flags);
      else {
        const needle = caseSensitive ? source : source.toLocaleLowerCase();
        matcher = { test: (text) => (caseSensitive ? text : text.toLocaleLowerCase()).includes(needle) };
      }
      (negative ? excludes : includes).push(matcher);
    } catch (error) {
      errors.push(`“${source}”: ${error.message}`);
    }
  }
  return {
    valid: errors.length === 0,
    error: errors.join(" · "),
    test(text) {
      if (errors.length) return false;
      const candidate = String(text || "");
      const included = !includes.length || includes.some((matcher) => matcher.test(candidate));
      return included && !excludes.some((matcher) => matcher.test(candidate));
    }
  };
}

export function filterItems(items, filters) {
  const expression = compileExpression(filters.query, filters.mode, filters.caseSensitive);
  if (!expression.valid) return { items: [], error: expression.error };
  const extensions = new Set(splitExpressions(filters.extensions).map((v) => v.replace(/^\./, "").toLowerCase()));
  const categories = new Set(filters.categories || []);
  const sources = new Set(filters.sources || []);
  const min = Number(filters.minSizeMb) * 1024 * 1024;
  const max = Number(filters.maxSizeMb) * 1024 * 1024;
  const output = items.filter((item) => {
    const text = filters.matchTarget === "url" ? item.url : item.filename;
    if (!expression.test(text)) return false;
    if (extensions.size && !extensions.has(item.extension?.toLowerCase())) return false;
    if (categories.size && !categories.has(item.category)) return false;
    if (sources.size && ![...sources].some((source) => item.sourceType === source || item.sourceType.startsWith(`${source}-`))) return false;
    if (filters.sizeState === "known" && !item.sizeKnown) return false;
    if (filters.sizeState === "unknown" && item.sizeKnown) return false;
    if (Number.isFinite(min) && min > 0 && (!item.sizeKnown || item.sizeBytes < min)) return false;
    if (Number.isFinite(max) && max > 0 && (!item.sizeKnown || item.sizeBytes > max)) return false;
    if (filters.downloadable === "yes" && !item.downloadable) return false;
    if (filters.downloadable === "no" && item.downloadable) return false;
    if (Number(filters.minOccurrences) > 1 && item.occurrenceCount < Number(filters.minOccurrences)) return false;
    if (filters.hostname) {
      try { if (new URL(item.url).hostname !== filters.hostname) return false; } catch { return false; }
    }
    return true;
  });
  return { items: output, error: "" };
}

export function sortItems(items, sortKey = "discoveryIndex", direction = "asc") {
  const factor = direction === "desc" ? -1 : 1;
  return [...items].sort((a, b) => {
    let left = a[sortKey];
    let right = b[sortKey];
    if (sortKey === "hostname") {
      try { left = new URL(a.url).hostname; } catch { left = ""; }
      try { right = new URL(b.url).hostname; } catch { right = ""; }
    }
    if (sortKey === "sizeBytes") {
      left = a.sizeKnown ? a.sizeBytes : -1;
      right = b.sizeKnown ? b.sizeBytes : -1;
    }
    if (typeof left === "number" && typeof right === "number") return (left - right) * factor;
    return String(left || "").localeCompare(String(right || ""), undefined, { numeric: true, sensitivity: "base" }) * factor;
  });
}
