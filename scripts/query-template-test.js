/* eslint-env node */
/* eslint-disable strict -- CommonJS tests use file-level strict mode. */
"use strict";
const assert = require("node:assert/strict");
const {test} = require("node:test");
const fs = require("node:fs/promises");
const field = (name, type = "string", props = {}) => ({name, type, filterable: true, sortable: true, groupable: true, ...props});
const describe = {name: "Account", fields: [field("Id", "id"), field("Name", "string", {nameField: true}), field("CreatedDate", "datetime"), field("LastModifiedDate", "datetime"), field("Industry", "picklist"), field("Description", "textarea", {filterable: false, groupable: false})]};
const values = {object: "Account", days: "7", ids: "001000000000001AAA", field: "Name", keyword: "Acme"};
function storage() {
  const data = new Map();
  return {getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value)};
}
test("built-in patterns validate metadata and input", async t => {
  const {buildQuery, builtInTemplates, quoteText} = await import("../addon/query-templates.js");
  await t.test("six useful patterns generate complete queries", () => {
    assert.equal(builtInTemplates.length, 6);
    for (const template of builtInTemplates) {
      assert.doesNotMatch(buildQuery(template.id, values, describe), /\bLIMIT\b/i);
    }
    assert.equal(buildQuery("ids", values, describe), "SELECT Id, Name\nFROM Account\nWHERE Id = '001000000000001AAA'");
    assert.match(buildQuery("ids", {...values, ids: "001000000000001AAA,001000000000002AAA\n001000000000001AAA"}, describe), /IN \('001000000000001AAA', '001000000000002AAA'\)/);
    assert.match(buildQuery("created", values, describe), /CreatedDate = LAST_N_DAYS:7 ORDER BY CreatedDate DESC/);
    assert.match(buildQuery("modified", values, describe), /LastModifiedDate = LAST_N_DAYS:7 ORDER BY LastModifiedDate DESC/);
    assert.match(buildQuery("search", values, describe), /Name LIKE '%Acme%'/);
    assert.match(buildQuery("group", {...values, field: "Industry"}, describe), /SELECT Industry, COUNT\(Id\) recordCount[\s\S]*GROUP BY Industry[\s\S]*ORDER BY COUNT\(Id\) DESC/);
    assert.match(buildQuery("duplicates", values, describe), /WHERE Name != null[\s\S]*HAVING COUNT\(Id\) > 1/);
  });
  await t.test("ID lists accept quotes and array brackets while preserving validation and deduplication", () => {
    const ids = ["0058500000789dBAAQ", "00585000007940oAAA", "00585000007BGv7AAG"];
    const userDescribe = {...describe, name: "User"};
    const query = input => buildQuery("ids", {object: "User", ids: input}, userDescribe);
    const expected = "SELECT Id, Name\nFROM User\nWHERE Id IN ('0058500000789dBAAQ', '00585000007940oAAA', '00585000007BGv7AAG')";
    for (const input of [ids.map(id => `"${id}"`).join(",\n  "), JSON.stringify(ids, null, 2), ids.map(id => `'${id}'`).join(", "), ids.join("; ")]) {
      assert.equal(query(input), expected);
    }
    assert.equal(query(`["${ids[0]}", "${ids[0]}"]`), `SELECT Id, Name\nFROM User\nWHERE Id = '${ids[0]}'`);
    assert.equal(query('"0058500000789dB"'), "SELECT Id, Name\nFROM User\nWHERE Id = '0058500000789dB'");
    for (const input of ["", "[]", '[""]', '["invalid"]', `["${ids[0]}"`, `"${ids[0]}'`, `[["${ids[0]}"]]`, `"${ids[0]}" OR Id != null`]) {
      assert.throws(() => query(input), /Enter Salesforce IDs/);
    }
  });
  await t.test("literal escaping and wildcard input cannot change the query structure", () => {
    assert.equal(quoteText("O'Brien\\Co\n"), "'O\\'Brien\\\\Co\\n'");
    assert.match(buildQuery("search", {...values, keyword: "O'Brien_%"}, describe), /O\\'Brien\\_\\%/);
  });
  await t.test("unavailable, incompatible fields and invalid inputs are blocked", () => {
    for (const [id, patch] of [["ids", {ids: "001bad"}], ["search", {field: "Description"}], ["search", {keyword: ""}], ["group", {field: "Description"}], ["created", {days: "0"}], ["created", {days: "1 OR Id != null"}], ["created", {object: "Account WHERE"}]]) {
      assert.throws(() => buildQuery(id, {...values, ...patch}, describe));
    }
    assert.throws(() => buildQuery("created", values, {...describe, fields: describe.fields.filter(f => f.name !== "CreatedDate")}), /unavailable/);
    assert.throws(() => buildQuery("created", values, null), /wait/);
    assert.throws(() => buildQuery("created", values, {...describe, fields: describe.fields.map(f => ({...f, sortable: false}))}), /sorted/);
  });
});
test("custom parameters and legacy storage", async t => {
  const api = await import("../addon/query-templates.js");
  const template = {id: "test", name: "Customers", query: "SELECT {{field}} FROM {{object}} WHERE Name = {{name}} AND LastActivityDate >= {{date}} LIMIT {{limit}}", parameters: [{name: "field", type: "field"}, {name: "object", type: "object"}, {name: "name", type: "text"}, {name: "date", type: "date"}, {name: "limit", type: "number"}], useToolingApi: true};
  const input = {field: "Id", object: "Account", name: "O'Brien", date: "2026-10-14", limit: "20"};
  await t.test("five types render literals once and reject invalid values", () => {
    assert.equal(api.renderCustom(template, input), "SELECT Id FROM Account WHERE Name = 'O\\'Brien' AND LastActivityDate >= 2026-10-14 LIMIT 20");
    for (const patch of [{object: "Account WHERE Id != null"}, {field: "Id,Name"}, {limit: "1e2"}, {date: "2026-02-30"}, {name: ""}]) { assert.throws(() => api.renderCustom(template, {...input, ...patch})); }
    assert.throws(() => api.validateTemplate({...template, query: "SELECT Id FROM Account WHERE Name='{{name}}'"}), /outside quotes/);
    assert.throws(() => api.validateTemplate({...template, query: "SELECT Id FROM Account // {{name}}"}), /comments/);
    assert.throws(() => api.validateTemplate({...template, query: "SELECT {{bad name}} FROM Account"}), /Parameters/);
    assert.equal(api.renderCustom({...template, query: "SELECT Id FROM Account WHERE Name={{name}} OR Other__c={{name}}"}, input).match(/O\\'Brien/g).length, 2);
  });
  await t.test("save, edit and delete persist without mutating legacy configuration", () => {
    const store = storage();
    store.setItem("queryTemplates", "SELECT Id FROM//SELECT Id FROM WHERE");
    api.saveTemplate(template, store);
    api.saveTemplate({...template, name: "Renamed"}, store);
    const rows = api.readTemplates(store);
    assert.equal(rows.filter(t => t.kind === "custom").length, 1);
    assert.equal(rows.find(t => t.id === "test").name, "Renamed");
    assert.equal(rows.find(t => t.id === "test").useToolingApi, true);
    assert.equal(rows.filter(t => t.kind === "legacy").length, 2);
    assert.equal(rows.filter(t => t.kind === "starter").length, 2);
    api.deleteTemplate("test", store);
    assert.equal(api.readTemplates(store).filter(t => t.kind === "custom").length, 0);
    assert.equal(store.getItem("queryTemplates"), "SELECT Id FROM//SELECT Id FROM WHERE");
  });
  await t.test("damaged and failing storage never reports success", () => {
    const store = storage();
    store.setItem(api.TEMPLATE_KEY, "broken");
    assert.throws(() => api.saveTemplate(template, store));
    assert.equal(store.getItem(api.TEMPLATE_KEY), "broken");
    store.setItem(api.TEMPLATE_KEY, JSON.stringify([null, {id: "bad"}, template]));
    assert.equal(api.readTemplates(store).filter(t => t.kind === "custom").length, 1);
    assert.throws(() => api.saveTemplate(template, {getItem: () => null, setItem() { throw new Error("quota"); }}), /quota/);
  });
});
test("panel uses preview-only selection and guarded tab loading", async t => {
  const source = await fs.readFile(new URL("../addon/query-template-panel.js", `file://${__filename}`), "utf8");
  const api = await import("../addon/query-templates.js");
  const history = await import("../addon/query-history.js");
  global.React = require("../addon/react.js");
  const {QueryLibraryBrowser, queryLibraryRows, queryLibraryPosition} = await import("../addon/query-library-browser.js");
  const body = source.slice(source.indexOf("export class")).replace("export class", "class");
  class Component {
    constructor(props) { this.props = props; }
    setState(patch, callback) { Object.assign(this.state, patch); callback?.(); }
  }
  const names = ["React", "h", ...Object.keys(api), "querySummary", "previewTokens", "QueryLibraryBrowser", "queryLibraryRows", "queryLibraryPosition", "window"];
  const Panel = new Function(...names, body + "\nreturn QueryTemplatePanel;")({Component}, (tag, props, ...children) => ({tag, props: props || {}, children}), ...Object.values(api), history.querySummary, history.previewTokens, QueryLibraryBrowser, queryLibraryRows, queryLibraryPosition, {innerWidth: 1200, innerHeight: 800});
  function panel() {
    const loads = [];
    const model = {queryInput: {value: "SELECT Id FROM Account", focus() {}}, queryTooling: false, isWorking: false, hasQueryEdits: () => false, loadHistoryQuery: (...args) => loads.push(args), doExport: () => loads.push("run"), didUpdate() {}, describeInfo: {describeGlobal: () => ({globalStatus: "ready", globalDescribe: {sobjects: [{name: "Account", queryable: true}]}}), describeSobject: () => ({sobjectDescribe: describe, sobjectStatus: "ready"})}};
    const panel = new Panel({model});
    panel.cancel = {focus() {}};
    panel.state = {...panel.state, open: true, templates: api.builtInTemplates, selected: "created", tooling: false, values: {...values}};
    return {panel, model, loads};
  }
  await t.test("search filters globally by words and sorts only by usage without taking input focus", () => {
    const {panel: p} = panel();
    const browser = new QueryLibraryBrowser(p.libraryProps());
    Object.defineProperty(browser, "props", {get: () => p.libraryProps()});
    Object.defineProperty(browser, "search", {get: () => p.search});
    p.state.templates = [
      {id: "prefix", name: "Case history", kind: "builtin", runCount: 40},
      {id: "exact", name: "Case", kind: "custom", parameters: [], runCount: 1},
      {id: "popular", name: "Case", kind: "starter", runCount: 10}
    ];
    assert.deepEqual(p.rows().map(t => t.id), ["prefix", "popular", "exact"]);
    let focused = 0;
    const list = {scrollTop: 420, focus() { focused++; }};
    p.search = {};
    global.document = {activeElement: p.search};
    browser.list = list;
    browser.changeSearch("中文Case");
    assert.equal(p.state.search, "Case");
    assert.deepEqual(p.rows().map(t => t.id), ["prefix", "popular", "exact"]);
    assert.equal(p.state.selected, "prefix");
    assert.equal(list.scrollTop, 0);
    assert.equal(focused, 0);
    assert.equal(document.activeElement, p.search);
    list.scrollTop = 200;
    browser.changeSearch("Case history");
    assert.equal(p.state.search, "Case history");
    assert.equal(p.state.selected, "prefix");
    assert.equal(list.scrollTop, 0);
    browser.changeSearch("missing");
    assert.equal(p.state.selected, null);
    assert.equal(document.activeElement, p.search);
  });
  await t.test("template panel renders the same shared search and option component as history", () => {
    const {panel: p} = panel();
    const browsers = [];
    function visit(node) {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (!node || typeof node !== "object") { return; }
      if (node.tag === QueryLibraryBrowser) { browsers.push(node); }
      visit(node.children);
    }
    visit(p.render());
    assert.equal(browsers.length, 1);
    assert.equal(browsers[0].props.listClassName, "template-list");
    assert.equal(new QueryLibraryBrowser(browsers[0].props).rows().length, api.builtInTemplates.length);
  });
  await t.test("selection and parameter changes never touch the editor or execute", () => {
    const {panel: p, model, loads} = panel();
    p.choose(api.builtInTemplates[2]);
    p.change("days", "10");
    assert.match(p.preview(p.selected(), p.currentMetadata(p.selected())).query, /LAST_N_DAYS:10/);
    assert.equal(model.queryInput.value, "SELECT Id FROM Account");
    assert.equal(loads.length, 0);
    p.load(true);
    assert.equal(loads[0][1], true);
    assert.equal(p.state.open, false);
  });
  await t.test("typing or pasting IDs fills the object from the first ID in every supported format", () => {
    const {panel: p, model, loads} = panel();
    p.state.selected = "ids";
    const objects = [{name: "Account", keyPrefix: "001", queryable: true}, {name: "User", keyPrefix: "005", queryable: true}];
    model.describeInfo.describeGlobal = () => ({globalStatus: "ready", globalDescribe: {sobjects: objects}});
    model.describeInfo.describeSobject = (tooling, name) => ({sobjectStatus: "ready", sobjectDescribe: {...describe, name}});
    for (const ids of ["0058500000789dBAAQ", '"0058500000789dBAAQ",\n "001000000000001AAA"', '["0058500000789dBAAQ",\n "001000000000001AAA"]']) {
      p.change("object", "Account");
      p.change("ids", ids);
      assert.equal(p.state.values.object, "User");
      assert.match(p.preview(p.selected(), p.currentMetadata(p.selected())).query, /FROM User/);
    }
    p.change("ids", "001000000000001");
    assert.equal(p.state.values.object, "Account");
    p.change("object", "User");
    p.componentDidUpdate({}, {...p.state});
    assert.equal(p.state.values.object, "User");
    assert.equal(loads.length, 0);
    assert.equal(model.queryInput.value, "SELECT Id FROM Account");
  });
  await t.test("ID object detection waits for metadata and uses the current input and API", () => {
    const {panel: p, model} = panel();
    p.state.selected = "ids";
    let ready = false;
    const calls = [];
    model.describeInfo.describeGlobal = tooling => {
      calls.push(tooling);
      return {globalStatus: ready ? "ready" : "loading", globalDescribe: ready ? {sobjects: [{name: tooling ? "ToolingUser" : "User", keyPrefix: "005", queryable: true}]} : null};
    };
    p.change("ids", "0058500000789dBAAQ");
    assert.equal(p.state.values.object, "Account");
    assert.equal(p.pendingIdObject, true);
    ready = true;
    p.componentDidUpdate({}, {...p.state});
    assert.equal(p.state.values.object, "User");
    assert.equal(p.pendingIdObject, false);
    const previous = {...p.state};
    p.state.tooling = true;
    p.componentDidUpdate({}, previous);
    assert.equal(p.state.values.object, "ToolingUser");
    assert.equal(calls.at(-1), true);
    ready = false;
    p.change("ids", "00585000007940oAAA");
    p.change("ids", "");
    ready = true;
    p.componentDidUpdate({}, {...p.state});
    assert.equal(p.state.values.object, "ToolingUser");
    assert.equal(p.pendingIdObject, false);
  });
  await t.test("invalid, unknown, ambiguous and unqueryable prefixes leave the object unchanged", () => {
    const {panel: p, model} = panel();
    p.state.selected = "ids";
    model.describeInfo.describeGlobal = () => ({globalStatus: "ready",
      globalDescribe: {sobjects: [
        {name: "Hidden", keyPrefix: "005", queryable: false},
        {name: "SharedA", keyPrefix: "001", queryable: true},
        {name: "SharedB", keyPrefix: "001", queryable: true}
      ]}});
    for (const ids of ["", "005", "invalid,0058500000789dBAAQ", "9998500000789dBAAQ", "0058500000789dBAAQ", "001000000000001AAA"]) {
      p.change("ids", ids);
      assert.equal(p.state.values.object, "Account");
    }
    p.state.selected = "created";
    p.change("ids", "0058500000789dBAAQ");
    assert.equal(p.state.values.object, "Account");
  });
  await t.test("dirty edits confirm; running exports and invalid parameters block loading", () => {
    const {panel: p, model, loads} = panel();
    model.hasQueryEdits = () => true;
    p.load(false);
    assert.equal(p.state.replace, true);
    assert.equal(loads.length, 0);
    p.load(false, true);
    assert.equal(loads.length, 1);
    model.isWorking = true;
    p.load(true);
    assert.equal(loads.length, 1);
    model.isWorking = false;
    p.change("days", "0");
    p.load(true);
    assert.equal(loads.length, 1);
  });
  await t.test("failed tab persistence leaves the panel open and displays an error", () => {
    const {panel: p, model} = panel();
    model.loadHistoryQuery = () => { throw new Error("quota"); };
    p.load(true);
    assert.equal(p.state.open, true);
    assert.match(p.state.error, /Could not save/);
  });
  await t.test("Enter loads before running, while clicks only load", () => {
    const {panel: p, loads} = panel();
    const event = {key: "Enter", target: {closest: () => true}, preventDefault() {}, stopPropagation() {}};
    p.navigate(event);
    assert.equal(loads.length, 2);
    assert.match(loads[0][0].query, /LAST_N_DAYS:7/);
    assert.equal(loads[1], "run");
    const second = panel();
    second.panel.load(false);
    assert.equal(second.loads.length, 1);
  });
  await t.test("Enter respects validation, export activity, editing, composition and repeated keys", () => {
    const event = {key: "Enter", target: {closest: () => true}, preventDefault() {}, stopPropagation() {}};
    for (const state of [{editing: {}}, {replace: true}]) {
      const {panel: p, loads} = panel();
      Object.assign(p.state, state);
      p.navigate(event);
      assert.equal(loads.length, 0);
    }
    for (const flags of [{isComposing: true}, {repeat: true}, {shiftKey: true}]) {
      const {panel: p, loads} = panel();
      p.navigate({...event, ...flags});
      assert.equal(loads.length, 0);
    }
    const {panel: p, model, loads} = panel();
    model.isWorking = true;
    p.navigate(event);
    model.isWorking = false;
    p.change("days", "0");
    p.navigate(event);
    assert.equal(loads.length, 0);
  });
  await t.test("Enter carries execution through replace confirmation and blocks it after save failure", () => {
    const {panel: p, model, loads} = panel();
    model.hasQueryEdits = () => true;
    p.load(false, false, true);
    assert.equal(p.state.replace, true);
    assert.equal(p.state.runAfterLoad, true);
    assert.equal(loads.length, 0);
    p.load(false, true, p.state.runAfterLoad);
    assert.equal(loads[1], "run");
    const failed = panel();
    failed.model.loadHistoryQuery = () => { throw new Error("quota"); };
    failed.panel.load(false, false, true);
    assert.equal(failed.loads.length, 0);
    assert.equal(failed.panel.state.open, true);
  });
  await t.test("object picker selects API names; exact Enter loads and runs", () => {
    const {panel: p, loads} = panel();
    p.state.objectPicker = "object";
    p.state.values.object = "acc";
    const input = () => p.objectInput("Object", "object", p.currentMetadata(p.selected())).children[1];
    const event = {key: "Enter", preventDefault() {}, stopPropagation() {}};
    input().props.onKeyDown(event);
    assert.equal(p.state.values.object, "Account");
    assert.equal(loads.length, 0);
    input().props.onFocus();
    input().props.onKeyDown(event);
    assert.equal(loads[1], "run");
    const search = panel();
    search.panel.state.selected = "search";
    search.panel.state.objectPicker = "object";
    search.panel.state.values.object = "account";
    search.panel.objectInput("Object", "object", search.panel.currentMetadata(search.panel.selected())).children[1].props.onKeyDown(event);
    assert.equal(search.panel.state.values.field, "Name");
    assert.match(search.loads[0][0].query, /Name LIKE/);
    assert.equal(search.loads[1], "run");
  });
  await t.test("selecting an entire quoted value creates a typed parameter", () => {
    const {panel: p} = panel();
    const query = "SELECT Id FROM Account WHERE Name = 'Acme'";
    p.state.editing = {name: "Search", query, parameters: []};
    p.queryEditor = {selectionStart: query.indexOf("Acme"), selectionEnd: query.indexOf("Acme") + 4, focus() {}};
    p.makeParameter();
    assert.match(p.state.editing.query, /Name = \{\{value1\}\}$/);
    assert.deepEqual(p.state.editing.parameters, [{name: "value1", type: "text", default: "Acme"}]);
    assert.equal(api.renderCustom(p.state.editing, {value1: "Other"}), "SELECT Id FROM Account WHERE Name = 'Other'");
  });
});

test("object suggestions rank exact names, labels, prefixes and substrings", async () => {
  const {matchingObjects} = await import("../addon/query-templates.js");
  const objects = [
    {name: "BriefcaseAssignment", label: "Briefcase Assignment", queryable: true},
    {name: "CaseArticle", queryable: true},
    {name: "Case", label: "Case", queryable: true},
    {name: "Ticket__c", label: "Case", queryable: true},
    {name: "Other__c", label: "Case Detail", queryable: true},
    {name: "Unqueryable", label: "Case", queryable: false},
    {name: "Account", queryable: true}
  ];
  assert.deepEqual(matchingObjects(objects, " CaSe ").map(o => o.name), ["Case", "Ticket__c", "CaseArticle", "Other__c", "BriefcaseAssignment"]);
  assert.equal(objects[0].name, "BriefcaseAssignment");
  assert.equal(matchingObjects(objects, "nothing").length, 0);
  assert.equal(matchingObjects(objects, "").length, 6);
});

test("template run counts persist independently for built-in and custom templates", async () => {
  const api = await import("../addon/query-templates.js");
  const store = storage();
  api.saveTemplate({id: "mine", name: "Mine", query: "SELECT Id FROM Account", parameters: []}, store);
  api.recordTemplateRun("ids", store);
  api.recordTemplateRun("ids", store);
  api.recordTemplateRun("mine", store);
  const rows = api.readTemplates(store);
  assert.equal(rows.find(t => t.id === "ids").runCount, 2);
  assert.equal(rows.find(t => t.id === "mine").runCount, 1);
  assert.equal(rows.find(t => t.id === "created").runCount, 0);
  api.saveTemplate({...rows.find(t => t.id === "mine"), name: "Renamed"}, store);
  assert.equal(api.readTemplates(store).find(t => t.id === "mine").runCount, 1);
});
