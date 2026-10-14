const assert = require("node:assert/strict");
const {test} = require("node:test");
const fs = require("node:fs/promises");

function memoryStorage(initial) {
  "use strict";
  let value = initial;
  return {getItem: () => value, setItem: (key, next) => { value = next; }, removeItem: () => { value = null; }};
}

test("query history data and tab integration", async t => {
  "use strict";
  const {QueryHistory, filterHistory, queryObject, querySummary, previewTokens, queryBaseline} = await import("../addon/query-history.js");
  const a = {query: "SELECT Id FROM Account", useToolingApi: false, lastExecutedAt: 30};
  const b = {query: "SELECT Name FROM Contact", useToolingApi: false, lastExecutedAt: 20};
  const c = {query: "SELECT Name FROM ApexClass", useToolingApi: true, lastExecutedAt: 10};
  await t.test("legacy and malformed entries remain safe; full text and all search terms match", () => {
    let old = {...a};
    delete old.lastExecutedAt;
    let history = new QueryHistory("insextQueryHistory", 100, memoryStorage(JSON.stringify([null, "old", {}, old])));
    assert.deepEqual(history.list, [old]);
    let long = {query: a.query + " ".repeat(350) + "WHERE Name = 'needle'"};
    assert.deepEqual(filterHistory([long, b], " NEEDLE account "), [long]);
    assert.deepEqual(filterHistory([a, b], "account contact"), []);
  });
  await t.test("success updates timestamp and exact duplicates without merging modes", () => {
    let history = new QueryHistory("insextQueryHistory", 3, memoryStorage(JSON.stringify([a, b])));
    history.add({...a, lastExecutedAt: 40});
    assert.equal(history.list.length, 2);
    assert.equal(history.list[0].lastExecutedAt, 40);
    history.add({...a, useToolingApi: true});
    assert.equal(history.list.length, 3);
  });
  await t.test("deletion persists immediately; later executions respect the configured capacity", () => {
    let storage = memoryStorage(JSON.stringify([a, b, c]));
    let history = new QueryHistory("insextQueryHistory", 3, storage);
    assert.equal(history.remove(b), true);
    assert.deepEqual(new QueryHistory("insextQueryHistory", 3, storage).list, [a, c]);
    assert.equal(history.remove(b), null);
    history.add({...b, lastExecutedAt: 50});
    history.add({query: "SELECT Id FROM Lead", useToolingApi: false, lastExecutedAt: 60});
    assert.deepEqual(history.list.map(entry => entry.query), ["SELECT Id FROM Lead", b.query, a.query]);
  });
  await t.test("capacity defaults to 100 and can exceed 100", () => {
    assert.equal(new QueryHistory("history", undefined, memoryStorage(null)).max, 100);
    let history = new QueryHistory("history", 150, memoryStorage(null));
    for (let i = 0; i < 160; i++) { history.add({query: `SELECT Id FROM Account LIMIT ${i}`}); }
    assert.equal(history.list.length, 150);
    assert.equal(history.list[0].query, "SELECT Id FROM Account LIMIT 159");
  });
  await t.test("three summary rows split outer clauses and retain all trailing clauses", () => {
    let fields = "Id, (SELECT Id FROM Contact WHERE Name = 'from Case')";
    let clauses = "WHERE Name = 'from Lead' GROUP BY Id HAVING COUNT(Id) > 1 ORDER BY Id LIMIT 5 OFFSET 1";
    assert.deepEqual(querySummary(`SELECT ${fields} FROM /* comment */ Account ${clauses}`), {fields, object: "Account", clauses});
    assert.deepEqual(querySummary("SELECT Id FROM Account"), {fields: "Id", object: "Account", clauses: ""});
    assert.deepEqual(querySummary("FIND {hi} RETURNING Contact(Id)"), {fields: "FIND {hi} RETURNING Contact(Id)", object: "Query", clauses: ""});
    assert.equal(querySummary("SELECT Id FROM Account WHERE Name = 'broken").object, "Query");
  });
  await t.test("storage failures preserve the persisted list", () => {
    let storage = memoryStorage(JSON.stringify([a, b]));
    let history = new QueryHistory("insextQueryHistory", 100, storage);
    storage.setItem = () => { throw new Error("quota"); };
    assert.throws(() => history.remove(a));
    assert.deepEqual(history.list, [a, b]);
  });
  await t.test("object extraction ignores nested queries, strings and comments; preview preserves literals", () => {
    const query = "SELECT Id, (SELECT Id FROM Contact) FROM Account WHERE Name = 'from Lead' /* from Case */";
    assert.equal(queryObject(query), "Account");
    assert.equal(queryObject("FIND {hello} RETURNING Contact(Id)"), "Query");
    assert.equal(queryObject("SELECT Id FROM /* comment */ Account"), "Account");
    assert.ok(previewTokens(query).some(token => token.text === "'from Lead'"));
    assert.ok(previewTokens(query).some(token => token.text === "/* from Case */"));
    assert.deepEqual(previewTokens("SELECT Id FROM Account WHERE Name = 'broken"), [{text: "SELECT Id FROM Account WHERE Name = 'broken"}]);
  });

  // Exercise the actual Model methods without Salesforce initialization or network calls.
  const source = await fs.readFile(require.resolve("../addon/data-export.js"), "utf8");
  const body = source.slice(source.indexOf("class Model {"), source.indexOf("\nfunction RecordTable"));
  const storage = memoryStorage(null);
  const Model = new Function("queryBaseline", "localStorage", body + "\nreturn Model;")(queryBaseline, storage);
  function model() {
    const vm = Object.create(Model.prototype);
    Object.assign(vm, {
      sfHost: "example",
      queryInput: {value: a.query, focus() {}},
      queryTooling: false,
      queryAll: true,
      activeTabIndex: 0,
      isWorking: false,
      queryTabs: [{name: "Query 1", query: a.query, queryTooling: false, queryAll: true, results: {records: [1]}, baseline: queryBaseline(a.query, false, true)}],
      didUpdate() {},
      updatedExportedData() {},
      queryAutocompleteHandler() {},
      focusQueryInput() {}
    });
    return vm;
  }
  await t.test("dirty detection compares successful baseline, including modes", () => {
    let vm = model();
    assert.equal(vm.hasQueryEdits(), false);
    vm.queryInput.value += " LIMIT 1";
    assert.equal(vm.hasQueryEdits(), true);
    vm.queryInput.value = a.query;
    vm.queryAll = false;
    assert.equal(vm.hasQueryEdits(), true);
  });
  await t.test("new history tab preserves live editor text, modes and results", () => {
    let vm = model();
    vm.queryInput.value += " LIMIT 1";
    vm.loadHistoryQuery(c, true);
    assert.equal(vm.queryTabs[0].query, a.query + " LIMIT 1");
    assert.deepEqual(vm.queryTabs[0].results, {records: [1]});
    assert.equal(vm.activeTabIndex, 1);
    assert.equal(vm.queryInput.value, c.query);
    assert.equal(vm.queryTooling, true);
    assert.equal(vm.queryAll, false);
    assert.equal(vm.queryTabs[1].results, null);
    assert.equal(vm.hasQueryEdits(), false);
  });
  await t.test("replacement clears unrelated results, retains data mode and blocks while exporting", () => {
    let vm = model();
    vm.loadHistoryQuery(b, false);
    assert.equal(vm.queryTabs[0].results, null);
    assert.equal(vm.queryAll, true);
    vm.isWorking = true;
    vm.loadHistoryQuery(c, true);
    assert.equal(vm.queryTabs.length, 1);
    assert.equal(vm.queryInput.value, b.query);
  });
  await t.test("failed tab persistence leaves tabs and editor untouched", () => {
    let vm = model();
    let original = vm.queryTabs;
    vm.saveQueryTabs = () => { throw new Error("quota"); };
    assert.throws(() => vm.loadHistoryQuery(c, true));
    assert.equal(vm.queryTabs, original);
    assert.equal(vm.queryInput.value, a.query);
    assert.equal(vm.activeTabIndex, 0);
  });
});

test("history panel interactions", async t => {
  "use strict";
  global.React = require("../addon/react.js");
  const {QueryHistory, historyKey} = await import("../addon/query-history.js");
  const {QueryHistoryPanel} = await import("../addon/query-history-panel.js");
  const a = {query: "SELECT Id FROM Account", useToolingApi: false};
  const b = {query: "SELECT Id FROM Contact", useToolingApi: false};
  function panel() {
    const model = {queryHistory: new QueryHistory("history", 100, memoryStorage(JSON.stringify([a, b]))), didUpdate() {}, hasQueryEdits: () => true, queryInput: {focus() {}}, runs: 0, doExport() { this.runs++; }, loads: [], loadHistoryQuery(entry, newTab) { this.loads.push({entry, newTab}); }};
    const component = new QueryHistoryPanel({model});
    component.setState = (next, callback) => {
      Object.assign(component.state, typeof next === "function" ? next(component.state) : next);
      if (callback) { callback(); }
    };
    component.state.open = true;
    component.state.selected = historyKey(a);
    return {model, component};
  }
  await t.test("load requires replacement confirmation, while new tab preserves edits", () => {
    let {model, component} = panel();
    component.load(false);
    assert.equal(component.state.replace, true);
    assert.equal(model.loads.length, 0);
    component.load(true);
    assert.deepEqual(model.loads, [{entry: a, newTab: true}]);
    assert.equal(component.state.open, false);
  });
  await t.test("exporting blocks both loading actions even after confirmation", () => {
    let {model, component} = panel();
    model.isWorking = true;
    component.load(false, true);
    component.load(true);
    assert.equal(model.loads.length, 0);
  });
  await t.test("arrows select without loading; Enter loads, runs and closes even with editor changes", () => {
    let {model, component} = panel();
    const search = {dataset: {}};
    component.search.current = search;
    component.root.current = {querySelector: () => null};
    let prevented = 0;
    let event = key => ({key, target: search, preventDefault() { prevented++; }, stopPropagation() {}});
    component.navigate(event("ArrowDown"));
    assert.equal(component.state.selected, historyKey(b));
    assert.equal(model.loads.length, 0);
    component.navigate(event("ArrowUp"));
    assert.equal(component.state.selected, historyKey(a));
    component.navigate(event("Enter"));
    assert.deepEqual(model.loads, [{entry: a, newTab: false}]);
    assert.equal(model.runs, 1);
    assert.equal(component.state.open, false);
    assert.equal(component.state.replace, false);
    assert.equal(prevented, 3);
  });
  await t.test("Enter on a row runs once; empty, busy and composing states do not run", () => {
    let {model, component} = panel();
    const event = {key: "Enter", target: {dataset: {historyRow: "true"}}, preventDefault() {}, stopPropagation() {}};
    component.navigate({...event, isComposing: true});
    assert.equal(model.runs, 0);
    model.isWorking = true;
    component.navigate(event);
    assert.equal(model.runs, 0);
    model.isWorking = false;
    component.state.search = "missing";
    component.navigate(event);
    assert.equal(model.runs, 0);
    component.state.search = "";
    component.navigate(event);
    assert.equal(model.runs, 1);
  });
  await t.test("candidate rendering has exactly three rows and no Undo control", () => {
    let {component} = panel();
    global.window = {innerWidth: 1280, innerHeight: 900};
    const tree = component.render();
    const nodes = [];
    function visit(node) {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (!node || typeof node !== "object") { return; }
      nodes.push(node);
      visit(node.props?.children);
    }
    visit(tree);
    const candidates = nodes.filter(node => node.props?.className === "history-select");
    assert.equal(candidates.length, 2);
    assert.deepEqual(candidates[0].props.children.map(row => row.props.children), ["Id", "Account", "\u00a0"]);
    assert.equal(nodes.some(node => node.type === "button" && String(node.props.children).includes("Undo")), false);
  });
  await t.test("failed load keeps the panel open and does not run", () => {
    let {model, component} = panel();
    model.loadHistoryQuery = () => { throw new Error("quota"); };
    component.load(false, true, true);
    assert.equal(model.runs, 0);
    assert.equal(component.state.open, true);
    assert.ok(component.state.error);
  });
  await t.test("filtered deletion persists with no restoration action", () => {
    let {model, component} = panel();
    component.state.search = "account";
    component.delete(a);
    assert.deepEqual(model.queryHistory.list, [b]);
    assert.equal(component.selected(), undefined);
    component.close();
    model.queryHistory.refresh();
    assert.deepEqual(model.queryHistory.list, [b]);
    assert.equal(component.undo, undefined);
  });
  await t.test("storage failure leaves the record available", () => {
    let {model, component} = panel();
    model.queryHistory.storage.setItem = () => { throw new Error("quota"); };
    component.delete(a);
    assert.deepEqual(model.queryHistory.list, [a, b]);
    assert.ok(component.state.error.includes("Could not delete"));
  });
  await t.test("clear all cancellation preserves history; confirmation deletes all", () => {
    let {model, component} = panel();
    component.delete(a);
    global.window = {confirm: () => false};
    component.clear();
    assert.deepEqual(model.queryHistory.list, [b]);
    global.window.confirm = () => true;
    component.clear();
    assert.deepEqual(model.queryHistory.list, []);
  });
});
