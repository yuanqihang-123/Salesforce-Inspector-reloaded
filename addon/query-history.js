// History identity deliberately preserves the existing exact-text deduplication.
export function historyKey(entry) {
  return JSON.stringify([entry.query, !!entry.useToolingApi]);
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
  add(entry) {
    let history = this._get().filter(e => historyKey(e) !== historyKey(entry));
    history.unshift(entry);
    this.write(history.slice(0, this.max));
  }
  remove(entry) {
    let history = this._get();
    let index = history.findIndex(e => historyKey(e) === historyKey(entry));
    if (index < 0) { return null; }
    this.write(history.filter(e => historyKey(e) !== historyKey(entry)));
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
