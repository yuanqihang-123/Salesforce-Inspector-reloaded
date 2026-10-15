// Templates hold query patterns; query history holds successful executions.
export const TEMPLATE_KEY = "queryTemplatesV2";
export const TEMPLATE_USAGE_KEY = "queryTemplateRunCounts";
export const parameterTypes = ["text", "number", "date", "object", "field"];
export const builtInTemplates = [
  {id: "ids", name: "Find records by ID", description: "Look up one or more record IDs", kind: "builtin"},
  {id: "created", name: "Recently created records", description: "Created in the last N days", kind: "builtin"},
  {id: "modified", name: "Recently modified records", description: "Modified in the last N days", kind: "builtin"},
  {id: "search", name: "Search a text field", description: "Find records containing a keyword", kind: "builtin"},
  {id: "group", name: "Count by field", description: "Group records and count each value", kind: "builtin"},
  {id: "duplicates", name: "Find duplicate values", description: "Find values appearing more than once", kind: "builtin"}
];
export const starterTemplates = [
  {id: "sosl", name: "SOSL search", kind: "starter", query: 'FIND {""}\nIN Name Fields\nRETURNING Contact(Name, Phone)', parameters: []},
  {id: "graphql", name: "GraphQL contacts", kind: "starter", query: "{\n  uiapi {\n    query {\n      Contact {\n        edges {\n          node {\n            Id\n            Name { value }\n          }\n        }\n      }\n    }\n  }\n}", parameters: []}
];
export function quoteText(value) {
  return "'" + String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t") + "'";
}
export function matchingObjects(objects, input) {
  let term = String(input || "").trim().toLowerCase();
  let rank = object => {
    let name = object.name.toLowerCase();
    let label = (object.label || "").toLowerCase();
    if (!term || name === term) { return 0; }
    if (label === term) { return 1; }
    if (name.startsWith(term)) { return 2; }
    if (label.startsWith(term)) { return 3; }
    if (name.includes(term)) { return 4; }
    if (label.includes(term)) { return 5; }
    return 6;
  };
  return objects.filter(o => o.queryable && rank(o) < 6).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
function identifier(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) { throw new Error("Choose a valid object or field API name."); }
  return value;
}
function integer(value, label, max) {
  if (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > max) { throw new Error(`${label} must be between 1 and ${max}.`); }
  return String(Number(value));
}
export function parametersIn(query) {
  return [...new Set([...query.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g)].map(match => match[1]))];
}
export function validateTemplate(template) {
  if (!template.name?.trim() || !template.query?.trim()) { throw new Error("Enter a template name and query."); }
  let names = parametersIn(template.query);
  if (template.query.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, "").match(/\{\{|\}\}/)) { throw new Error("Parameters must use {{name}} with letters, numbers or underscores."); }
  // A parameter replaces a complete literal/identifier, never part of a quoted string or comment.
  let quoted = false;
  let comment = "";
  for (let i = 0; i < template.query.length; i++) {
    let pair = template.query.slice(i, i + 2);
    if (pair === "{{" && (quoted || comment)) { throw new Error("Place parameters outside quotes and comments; text parameters add their own quotes."); }
    if (comment === "line") { if (template.query[i] === "\n") { comment = ""; } continue; }
    if (comment === "block") { if (pair === "*/") { comment = ""; i++; } continue; }
    if (quoted && template.query[i] === "\\") { i++; continue; }
    if (template.query[i] === "'") { quoted = !quoted; continue; }
    if (!quoted && ["//", "--", "/*"].includes(pair)) { comment = pair === "/*" ? "block" : "line"; i++; }
  }
  if (quoted || comment === "block") { throw new Error("Close the query's quotes and comments."); }
  for (let name of names) {
    if (!parameterTypes.includes(template.parameters?.find(p => p.name === name)?.type)) { throw new Error(`Choose a type for ${name}.`); }
  }
  return template;
}
export function renderCustom(template, values) {
  validateTemplate(template);
  return template.query.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_, name) => {
    let parameter = template.parameters.find(p => p.name === name);
    let value = String(values[name] ?? "");
    if (!value.trim()) { throw new Error(`Enter ${name}.`); }
    if (parameter.type === "text") { return quoteText(value); }
    if (parameter.type === "object" || parameter.type === "field") { return identifier(value); }
    if (parameter.type === "number") {
      if (!/^-?\d+(\.\d+)?$/.test(value)) { throw new Error(`${name} must be a number.`); }
      return value;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) { throw new Error(`${name} must be a valid date (YYYY-MM-DD).`); }
    return value;
  });
}
export function buildQuery(id, values, describe) {
  let object = identifier(values.object || "");
  if (!describe || describe.name.toLowerCase() !== object.toLowerCase()) { throw new Error("Choose an object and wait for its fields to load."); }
  if (describe.queryable === false) { throw new Error("Choose a queryable object."); }
  let fields = describe.fields;
  let field = name => {
    let found = fields.find(f => f.name.toLowerCase() === name.toLowerCase());
    if (!found) { throw new Error(`${name} is unavailable on ${describe.name}.`); }
    return found;
  };
  let columns = [field("Id").name];
  let nameField = fields.find(f => f.nameField && f.type === "string");
  if (nameField && nameField.name !== "Id") { columns.push(nameField.name); }
  let suffix;
  if (id === "ids") {
    let input = String(values.ids || "").trim();
    if (input.startsWith("[") && input.endsWith("]")) { input = input.slice(1, -1); }
    let ids = [...new Set(input.split(/[\s,;]+/).filter(Boolean).map(value => value.replace(/^(["'])(.*)\1$/, "$2")))];
    if (!ids.length || ids.some(value => !/^(?:[A-Za-z0-9]{15}|[A-Za-z0-9]{18})$/.test(value))) { throw new Error("Enter Salesforce IDs of 15 or 18 characters, separated by commas or new lines. Quoted IDs and arrays are also supported."); }
    suffix = ids.length === 1 ? `WHERE Id = ${quoteText(ids[0])}` : `WHERE Id IN (${ids.map(quoteText).join(", ")})`;
  } else if (id === "created" || id === "modified") {
    let dateField = field(id === "created" ? "CreatedDate" : "LastModifiedDate");
    if (!dateField.filterable || !dateField.sortable) { throw new Error(`${dateField.name} cannot be filtered or sorted.`); }
    columns.push(dateField.name);
    suffix = `WHERE ${dateField.name} = LAST_N_DAYS:${integer(values.days, "Days", 3650)} ORDER BY ${dateField.name} DESC`;
  } else {
    let selected = field(identifier(values.field || ""));
    if (id === "search") {
      if (!selected.filterable || !["string", "textarea", "email", "phone", "url"].includes(selected.type)) { throw new Error("Choose a filterable text field."); }
      if (!values.keyword?.trim()) { throw new Error("Enter a keyword."); }
      if (!columns.includes(selected.name)) { columns.push(selected.name); }
      let keyword = quoteText(values.keyword).slice(1, -1).replace(/[%_]/g, "\\$&");
      suffix = `WHERE ${selected.name} LIKE '%${keyword}%'`;
    } else if (id === "group" || id === "duplicates") {
      if (!selected.groupable || (id === "duplicates" && !selected.filterable)) { throw new Error("Choose a groupable field (also filterable for duplicates)."); }
      return `SELECT ${selected.name}, COUNT(Id) recordCount\nFROM ${describe.name}\n${id === "duplicates" ? `WHERE ${selected.name} != null\n` : ""}GROUP BY ${selected.name}\n${id === "duplicates" ? "HAVING COUNT(Id) > 1\n" : ""}ORDER BY COUNT(Id) DESC`;
    } else { throw new Error("Unknown template."); }
  }
  return `SELECT ${columns.join(", ")}\nFROM ${describe.name}\n${suffix}`;
}
export function readTemplates(storage = localStorage) {
  let raw = storage.getItem(TEMPLATE_KEY);
  let custom = raw ? JSON.parse(raw) : [];
  if (!Array.isArray(custom)) { throw new Error("Saved templates could not be read."); }
  custom = custom.filter(t => {
    try { validateTemplate(t); return typeof t.id === "string" && Array.isArray(t.parameters); } catch { return false; }
  }).map(t => ({...t, kind: "custom"}));
  let legacy = (storage.getItem("queryTemplates") || "").split("//").filter(q => q.trim()).map((query, i) => ({id: `legacy-${i}`, name: `Legacy: ${query.trim().slice(0, 55)}`, query, parameters: [], kind: "legacy"}));
  const usage = JSON.parse(storage.getItem(TEMPLATE_USAGE_KEY) || "{}");
  return [...builtInTemplates, ...starterTemplates, ...custom, ...legacy].map(t => ({...t, runCount: templateRunCount(usage?.[t.id])}));
}
export function saveTemplate(template, storage = localStorage) {
  validateTemplate(template);
  let custom = readTemplates(storage).filter(t => t.kind === "custom" && t.id !== template.id);
  custom.push({...template, kind: "custom", parameters: template.parameters.filter(p => parametersIn(template.query).includes(p.name))});
  storage.setItem(TEMPLATE_KEY, JSON.stringify(custom));
}
export function deleteTemplate(id, storage = localStorage) {
  let custom = readTemplates(storage).filter(t => t.kind === "custom" && t.id !== id);
  storage.setItem(TEMPLATE_KEY, JSON.stringify(custom));
}

function templateRunCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
export function recordTemplateRun(id, storage = localStorage) {
  const usage = JSON.parse(storage.getItem(TEMPLATE_USAGE_KEY) || "{}");
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) { throw new Error("Invalid template usage data."); }
  storage.setItem(TEMPLATE_USAGE_KEY, JSON.stringify({...usage, [id]: templateRunCount(usage[id]) + 1}));
}
