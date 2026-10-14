// Canonical keys are comparison-only: history always stores the latest original text.
export function historyKey(entry) {
  return JSON.stringify([soqlIdentity(entry.query), !!entry.useToolingApi]);
}

function soqlIdentity(query) {
  try {
    // Keep string literals verbatim and token boundaries explicit (10 != 1 0).
    const pattern = /\s+|\/\*[\s\S]*?\*\/|--[^\n]*|\/\/[^\n]*|'(?:\\.|''|[^'\\])*'|[A-Za-z_][\w]*|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|!=|<=|>=|<>|[(),.:=<>+*/-]/gy;
    let tokens = [];
    let offset = 0;
    while (offset < query.length) {
      pattern.lastIndex = offset;
      const match = pattern.exec(query);
      if (!match) { throw new Error("Unsupported token"); }
      offset = pattern.lastIndex;
      const token = match[0];
      if (!/^\s|^(\/\*|--|\/\/)/.test(token)) {
        tokens.push(token.startsWith("'") ? token : token.toLowerCase());
      }
    }
    if (tokens.some((token, i) => token === ":" && /^[a-z_]/.test(tokens[i + 1] || ""))) {
      throw new Error("Context-dependent bind variable");
    }
    return ["soql", canonicalQuery(tokens)];
  } catch {
    // Unknown syntax must never merge distinct queries by accident.
    return ["text", query];
  }
}

// Split at the current nesting level, never inside functions, literals or subqueries.
function splitTokens(tokens, separator) {
  let parts = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "(") { depth++; }
    if (tokens[i] === ")") { depth--; }
    if (depth < 0) { throw new Error("Unbalanced query"); }
    if (depth === 0 && separator(tokens[i], i)) {
      parts.push(tokens.slice(start, i));
      start = i + 1;
    }
  }
  if (depth !== 0) { throw new Error("Unbalanced query"); }
  parts.push(tokens.slice(start));
  if (parts.some(part => !part.length)) { throw new Error("Empty expression"); }
  return parts;
}

function sortedIdentity(parts) {
  return parts.map(part => JSON.stringify(part)).sort();
}

function canonicalExpression(tokens) {
  let result = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== "(") {
      result.push(tokens[i]);
      continue;
    }
    let end = i + 1;
    let depth = 1;
    for (; end < tokens.length; end++) {
      if (tokens[end] === "(") { depth++; }
      if (tokens[end] === ")" && --depth === 0) { break; }
    }
    if (depth) { throw new Error("Unbalanced expression"); }
    const inner = tokens.slice(i + 1, end);
    result.push(inner[0] === "select" ? ["subquery", canonicalQuery(inner)] : ["parentheses", canonicalExpression(inner)]);
    i = end;
  }
  return result;
}

function canonicalCondition(tokens) {
  // Remove redundant outer groups, while retaining AND/OR precedence in the tree.
  while (tokens[0] === "(") {
    let depth = 0;
    const end = tokens.findIndex(token => {
      if (token === "(") { depth++; }
      if (token === ")") { depth--; }
      return depth === 0;
    });
    if (end !== tokens.length - 1) { break; }
    tokens = tokens.slice(1, -1);
  }
  for (const operator of ["or", "and"]) {
    const parts = splitTokens(tokens, token => token === operator);
    if (parts.length > 1) {
      const children = parts.map(canonicalCondition).flatMap(child => child[0] === operator ? child[1] : [child]);
      // Flatten matching operators so A AND (B AND C) equals C AND A AND B.
      return [operator, children.sort((a, b) => {
        const left = JSON.stringify(a);
        const right = JSON.stringify(b);
        return left < right ? -1 : left > right ? 1 : 0;
      })];
    }
  }
  if (tokens[0] === "not") { return ["not", canonicalCondition(tokens.slice(1))]; }
  return ["predicate", canonicalExpression(tokens)];
}

function canonicalQuery(tokens) {
  if (tokens[0] !== "select" || tokens.includes("typeof") || tokens.includes("between")) {
    throw new Error("Unsupported query structure");
  }
  const from = splitTokens(tokens, token => token === "from");
  if (from.length !== 2 || !/^[a-z_]\w*$/.test(from[1][0] || "")) {
    throw new Error("Missing SELECT or FROM");
  }
  const fields = splitTokens(from[0].slice(1), token => token === ",");
  const remainder = from[1];
  let where = -1;
  let whereEnd = remainder.length;
  let depth = 0;
  for (let i = 1; i < remainder.length; i++) {
    if (remainder[i] === "(") { depth++; }
    if (remainder[i] === ")") { depth--; }
    if (depth !== 0) { continue; }
    if (remainder[i] === "where") { where = i; }
    if (where >= 0 && /^(group|having|order|limit|offset|for|with|using|update|all)$/.test(remainder[i])) {
      whereEnd = i;
      break;
    }
  }
  return [
    sortedIdentity(fields.map(canonicalExpression)),
    canonicalExpression(remainder.slice(0, where < 0 ? remainder.length : where)),
    where < 0 ? null : canonicalCondition(remainder.slice(where + 1, whereEnd)),
    where < 0 ? [] : canonicalExpression(remainder.slice(whereEnd))
  ];
}

export class QueryHistory {
  constructor(storageKey, max, storage = localStorage) {
    this.storageKey = storageKey;
    this.max = Math.max(1, Number(max) || 100);
    this.storage = storage;
    this.list = this._get();
  }
  _get() {
    let history;
    try {
      history = JSON.parse(this.storage.getItem(this.storageKey));
    } catch {
      history = [];
    }
    history = Array.isArray(history) ? history.filter(e => e && typeof e.query === "string") : [];
    if (this.storageKey === "insextSavedQueryHistory") {
      history.sort((a, b) => a.query > b.query ? 1 : a.query < b.query ? -1 : 0);
    }
    if (this.storageKey === "insextQueryHistory") {
      // Existing history is newest-first. Collapse legacy duplicates on read;
      // the next successful save persists the compacted list.
      const seen = new Set();
      history = history.filter(entry => {
        const key = historyKey(entry);
        if (seen.has(key)) { return false; }
        seen.add(key);
        return true;
      });
    }
    this.list = history;
    return history;
  }
  refresh() { return this._get(); }
  write(history) {
    // Publish only after persistence succeeds.
    this.storage.setItem(this.storageKey, JSON.stringify(history));
    this.list = history;
    if (this.storageKey === "insextSavedQueryHistory") {
      this.list.sort((a, b) => a.query > b.query ? 1 : a.query < b.query ? -1 : 0);
    }
  }
  _key(entry) {
    // Preserve the legacy manually saved queries, including their labels.
    return this.storageKey === "insextSavedQueryHistory"
      ? JSON.stringify([entry.query, !!entry.useToolingApi]) : historyKey(entry);
  }
  add(entry) {
    const key = this._key(entry);
    let history = this._get().filter(e => this._key(e) !== key);
    history.unshift(entry);
    this.write(history.slice(0, this.max));
  }
  remove(entry) {
    const key = this._key(entry);
    let history = this._get();
    let index = history.findIndex(e => this._key(e) === key);
    if (index < 0) { return null; }
    this.write(history.filter(e => this._key(e) !== key));
    return true;
  }
  clear() {
    this.storage.removeItem(this.storageKey);
    this.list = [];
  }
}

export function filterHistory(list, search) {
  let terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter(e => terms.every(term => e.query.toLowerCase().includes(term)));
}

// Tokenize quoted strings and comments before inspecting or formatting clauses.
export function queryTokens(query) {
  let tokens = query.match(/'(?:\\.|''|[^'\\])*'|\/\*[\s\S]*?\*\/|--[^\n]*|\/\/[^\n]*|[A-Za-z_][\w.]*|\s+|./g) || [];
  if (tokens.some(t => t === "'" || t === '"') || tokens.join("") !== query) { return null; }
  return tokens;
}
export function queryObject(query) {
  let tokens = queryTokens(query);
  if (!tokens || !/^\s*select\b/i.test(query)) { return "Query"; }
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "(") { depth++; }
    if (tokens[i] === ")") { depth--; }
    if (depth === 0 && /^from$/i.test(tokens[i])) {
      let next = tokens.slice(i + 1).find(t => !/^\s+$/.test(t) && !/^(\/\*|--|\/\/)/.test(t));
      return /^[A-Za-z_]\w*$/.test(next || "") ? next : "Query";
    }
  }
  return "Query";
}
// Split only the outer SELECT/FROM; subqueries and quoted text stay intact.
export function querySummary(query) {
  let fallback = {fields: query.replace(/\s+/g, " ").trim(), object: "Query", clauses: ""};
  let tokens = queryTokens(query);
  if (!tokens) { return fallback; }
  let select = tokens.findIndex(t => !/^\s+$/.test(t) && !/^(\/\*|--|\/\/)/.test(t));
  if (select < 0 || !/^select$/i.test(tokens[select])) { return fallback; }
  let depth = 0;
  for (let i = select + 1; i < tokens.length; i++) {
    if (tokens[i] === "(") { depth++; }
    if (tokens[i] === ")") { depth--; }
    if (depth === 0 && /^from$/i.test(tokens[i])) {
      let object = i + 1;
      while (object < tokens.length && (/^\s+$/.test(tokens[object]) || /^(\/\*|--|\/\/)/.test(tokens[object]))) { object++; }
      if (!/^[A-Za-z_]\w*$/.test(tokens[object] || "")) { return fallback; }
      let compact = text => text.replace(/\s+/g, " ").trim();
      return {fields: compact(tokens.slice(select + 1, i).join("")), object: tokens[object], clauses: compact(tokens.slice(object + 1).join(""))};
    }
  }
  return fallback;
}

export function previewTokens(query) {
  let tokens = queryTokens(query);
  if (!tokens || !/^\s*select\b/i.test(query)) { return [{text: query}]; }
  let depth = 0;
  return tokens.map((token, i) => {
    if (token === ")") { depth--; }
    let keyword = /^(select|from|where|having|limit|offset|order|group|by|and|or|asc|desc|null|in|like|not)$/i.test(token);
    let clause = depth === 0 && /^(from|where|having|limit|offset|order|group)$/i.test(token);
    let text = (clause && i > 0 ? "\n" : "") + token;
    if (token === "(") { depth++; }
    return {text, kind: keyword ? "keyword" : token.startsWith("'") ? "string" : /^(\/\*|--|\/\/)/.test(token) ? "comment" : ""};
  });
}

export function queryBaseline(query, tooling, all) {
  return JSON.stringify([query, !!tooling, !!all]);
}
