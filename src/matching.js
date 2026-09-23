// 标题 / 作者名 / 标识符的规范化与相似度计算，为候选重复提供可解释的匹配依据。

export function normalizeTitle(title) {
  return String(title ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeName(name) {
  return normalizeTitle(name);
}

export function normalizeIdentifier(scheme, value) {
  let v = String(value ?? "").trim();
  if (scheme === "doi" || scheme === "preprint_doi") {
    v = v.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:/i, "").toLowerCase();
  } else if (scheme === "name_variant") {
    v = normalizeName(v);
  }
  return v;
}

function bigrams(s) {
  const compact = s.replace(/\s+/g, "");
  if (compact.length === 0) return new Set();
  if (compact.length === 1) return new Set([compact]);
  const out = new Set();
  for (let i = 0; i < compact.length - 1; i += 1) out.add(compact.slice(i, i + 2));
  return out;
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

// 中英文通用：词级 Jaccard 与字符二元组 Jaccard 取较大者。
export function titleSimilarity(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  return Math.max(
    jaccard(new Set(na.split(" ")), new Set(nb.split(" "))),
    jaccard(bigrams(na), bigrams(nb)),
  );
}

export function authorNames(authors) {
  return (authors ?? [])
    .map((a) => normalizeName(typeof a === "string" ? a : a?.name))
    .filter(Boolean);
}

// 较小作者集合在较大集合中的包含度，容忍作者列表截断。
export function authorOverlap(authorsA, authorsB) {
  const a = new Set(authorNames(authorsA));
  const b = new Set(authorNames(authorsB));
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / Math.min(a.size, b.size);
}

// 生成两条成果描述之间的匹配依据（evidence）与得分（0~1）。
// a / b 均为 { title, authors, identifiers } 形状。
export function scorePair(a, b) {
  const shared = [];
  for (const [scheme, value] of Object.entries(a.identifiers ?? {})) {
    const other = (b.identifiers ?? {})[scheme];
    if (other !== undefined && normalizeIdentifier(scheme, other) === normalizeIdentifier(scheme, value)) {
      shared.push(`${scheme}:${value}`);
    }
  }
  if (shared.length > 0) {
    return {
      score: 1,
      evidence: [{ rule: "identifier_exact", weight: 1, detail: `共享标识 ${shared.join(", ")}` }],
    };
  }
  const evidence = [];
  let score = 0;
  const sim = titleSimilarity(a.title, b.title);
  if (sim >= 0.9) {
    score += 0.6;
    evidence.push({ rule: "title_near_exact", weight: 0.6, detail: `标题相似度 ${sim.toFixed(2)}` });
  } else if (sim >= 0.6) {
    score += 0.4;
    evidence.push({ rule: "title_similar", weight: 0.4, detail: `标题相似度 ${sim.toFixed(2)}` });
  } else if (sim >= 0.45) {
    score += 0.2;
    evidence.push({ rule: "title_partial", weight: 0.2, detail: `标题相似度 ${sim.toFixed(2)}` });
  }
  const overlap = authorOverlap(a.authors, b.authors);
  if (overlap >= 0.8) {
    score += 0.4;
    evidence.push({ rule: "authors_match", weight: 0.4, detail: `作者重合度 ${overlap.toFixed(2)}` });
  } else if (overlap >= 0.5) {
    score += 0.25;
    evidence.push({ rule: "authors_overlap", weight: 0.25, detail: `作者重合度 ${overlap.toFixed(2)}` });
  } else if (overlap > 0) {
    score += 0.1;
    evidence.push({ rule: "authors_partial", weight: 0.1, detail: `作者重合度 ${overlap.toFixed(2)}` });
  }
  return { score: Math.min(1, Number(score.toFixed(3))), evidence };
}
