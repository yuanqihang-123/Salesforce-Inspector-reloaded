/* eslint-env node */
/* eslint-disable strict -- CommonJS tests use file-level strict mode. */
"use strict";
const assert = require("node:assert/strict");
const {test} = require("node:test");
const fs = require("node:fs/promises");
const field = (name, type = "string", props = {}) => ({name, type, filterable: true, sortable: true, groupable: true, ...props});
const describe = {name: "Account", fields: [field("Id", "id"), field("Name", "string", {nameField: true}), field("CreatedDate", "datetime"), field("LastModifiedDate", "datetime"), field("Industry", "picklist"), field("Description", "textarea", {filterable: false, groupable: false})]};
const values = {object: "Account", limit: "200", days: "7", ids: "001000000000001AAA", field: "Name", keyword: "Acme"};
function storage() {
  const data = new Map();
  return {getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value)};
}
test("built-in patterns validate metadata and input", async t => {
  const {buildQuery, builtInTemplates, quoteText} = await import("../addon/query-templates.js");
  await t.test("six useful patterns generate complete queries", () => {
    assert.equal(builtInTemplates.length, 6);
    assert.equal(buildQuery("ids", values, describe), "SELECT Id, Name\nFROM Account\nWHERE Id = '001000000000001AAA'\nLIMIT 200");
    assert.match(buildQuery("ids", {...values, ids: "001000000000001AAA,001000000000002AAA\n001000000000001AAA"}, describe), /IN \('001000000000001AAA', '001000000000002AAA'\)/);
    assert.match(buildQuery("created", values, describe), /CreatedDate = LAST_N_DAYS:7 ORDER BY CreatedDate DESC/);
    assert.match(buildQuery("modified", values, describe), /LastModifiedDate = LAST_N_DAYS:7 ORDER BY LastModifiedDate DESC/);
    assert.match(buildQuery("search", values, describe), /Name LIKE '%Acme%'/);
    assert.match(buildQuery("group", {...values, field: "Industry"}, describe), /SELECT Industry, COUNT\(Id\) recordCount[\s\S]*GROUP BY Industry[\s\S]*ORDER BY COUNT\(Id\) DESC/);
    assert.match(buildQuery("duplicates", values, describe), /WHERE Name != null[\s\S]*HAVING COUNT\(Id\) > 1/);
  });
  await t.test("literal escaping and wildcard input cannot change the query structure", () => {
    assert.equal(quoteText("O'Brien\\Co\n"), "'O\\'Brien\\\\Co\\n'");
    assert.match(buildQuery("search", {...values, keyword: "O'Brien_%"}, describe), /O\\'Brien\\_\\%/);
  });
  await t.test("unavailable, incompatible fields and invalid inputs are blocked", () => {
    for (const [id, patch] of [["ids", {ids: "001bad"}], ["search", {field: "Description"}], ["search", {keyword: ""}], ["group", {field: "Description"}], ["created", {days: "0"}], ["created", {days: "1 OR Id != null"}], ["created", {limit: "2001"}], ["created", {object: "Account WHERE"}]]) {
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
  const body = source.slice(source.indexOf("export class")).replace("export class", "class");
  class Component {
    constructor(props) { this.props = props; }
    setState(patch, callback) { Object.assign(this.state, patch); callback?.(); }
  }
  const names = ["React", "h", ...Object.keys(api), "querySummary", "previewTokens", "window"];
  const Panel = new Function(...names, body + "\nreturn QueryTemplatePanel;")({Component}, () => null, ...Object.values(api), history.querySummary, history.previewTokens, {innerWidth: 1200, innerHeight: 800});
  function panel() {
    const loads = [];
    const model = {queryInput: {value: "SELECT Id FROM Account", focus() {}}, queryTooling: false, isWorking: false, hasQueryEdits: () => false, loadHistoryQuery: (...args) => loads.push(args), describeInfo: {describeGlobal: () => ({globalStatus: "ready", globalDescribe: {sobjects: [{name: "Account", queryable: true}]}}), describeSobject: () => ({sobjectDescribe: describe, sobjectStatus: "ready"})}};
    const panel = new Panel({model});
    panel.cancel = {focus() {}};
    panel.state = {...panel.state, open: true, templates: api.builtInTemplates, selected: "created", tooling: false, values: {...values}};
    return {panel, model, loads};
  }
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
