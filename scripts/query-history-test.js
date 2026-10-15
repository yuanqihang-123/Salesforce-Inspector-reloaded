const assert = require("node:assert/strict");
const {test} = require("node:test");
const fs = require("node:fs/promises");

function memoryStorage(initial) {
  "use strict";
  let value = initial;
  return {getItem: () => value, setItem: (key, next) => { value = next; }, removeItem: () => { value = null; }};
}

test("SOQL semantic history identity", async t => {
  "use strict";
  const {QueryHistory, historyKey, compactQueryWhitespace} = await import("../addon/query-history.js");
  const key = query => historyKey({query, useToolingApi: false});
  const first = "SELECT Id,Name from User where IsActive = true and RP_StatusEventType__c = 'Manual Creation'";
  const latest = "SELECT Name, Id from User where RP_StatusEventType__c = 'Manual Creation'  and IsActive = true";
  await t.test("requested example keeps only the latest successful order, compact whitespace and timestamp", () => {
    const storage = memoryStorage(null);
    const history = new QueryHistory("insextQueryHistory", 100, storage);
    history.add({query: first, lastExecutedAt: 1});
    history.add({query: "SELECT Id FROM Account", lastExecutedAt: 2});
    history.add({query: latest, lastExecutedAt: 3});
    assert.deepEqual(history.list, [{query: compactQueryWhitespace(latest), lastExecutedAt: 3, runCount: 2}, {query: "SELECT Id FROM Account", lastExecutedAt: 2, runCount: 1}]);
    assert.deepEqual(new QueryHistory("insextQueryHistory", 100, storage).list, history.list);
  });
  await t.test("saving compacts whitespace without changing literals, comments or order", () => {
    const query = "  SELECT  Name,\tId, (SELECT  Name, Id FROM Contacts)\n FROM  Account WHERE Name = 'O\\'Brien  AND  Co'\t AND Other__c = 'it''s  ok'  ORDER BY Name, Id  ";
    const expected = "SELECT Name, Id, (SELECT Name, Id FROM Contacts) FROM Account WHERE Name = 'O\\'Brien  AND  Co' AND Other__c = 'it''s  ok' ORDER BY Name, Id";
    const storage = memoryStorage(null);
    const history = new QueryHistory("insextQueryHistory", 100, storage);
    const entry = {query, useToolingApi: true, lastExecutedAt: 10};
    history.add(entry);
    assert.equal(history.list[0].query, expected);
    assert.equal(JSON.parse(storage.getItem())[0].query, expected);
    assert.equal(entry.query, query);
    assert.equal(history.list[0].useToolingApi, true);
    assert.equal(history.list[0].lastExecutedAt, 10);
    assert.equal(history.remove(entry), true);
    const comments = " SELECT  Id /* keep  spacing */ FROM Account -- keep  comment\n WHERE Name='A  B' // another\n AND Id != null ";
    assert.equal(compactQueryWhitespace(comments), "SELECT Id /* keep  spacing */ FROM Account -- keep  comment\nWHERE Name='A  B' // another\nAND Id != null");
    const broken = "SELECT  Id FROM Account WHERE Name='broken  text";
    assert.equal(compactQueryWhitespace(broken), broken);
  });
  await t.test("field order, keyword case, whitespace and comments are immaterial", () => {
    assert.equal(key(first), key(latest));
    assert.equal(key("SELECT Account.Name, Id FROM Contact WHERE Age__c>=10"), key(" select id, account . name FROM /* from User */ contact\nWHERE age__c >= 10 "));
    assert.equal(key("SELECT Id FROM Account WHERE Name='A  B'"), key("SELECT Id FROM Account WHERE Name = 'A  B' // trailing"));
  });
  await t.test("boolean reordering preserves grouping, precedence and NOT", () => {
    const prefix = "SELECT Id FROM Account WHERE ";
    assert.equal(key(prefix + "A__c=1 AND (B__c=2 AND C__c=3)"), key(prefix + "C__c=3 AND A__c=1 AND B__c=2"));
    assert.equal(key(prefix + "A__c=1 AND (B__c=2 OR C__c=3)"), key(prefix + "(C__c=3 OR B__c=2) AND (A__c=1)"));
    assert.equal(key(prefix + "NOT (A__c=1 OR B__c=2)"), key(prefix + "NOT (B__c=2 OR A__c=1)"));
    assert.notEqual(key(prefix + "A__c=1 AND (B__c=2 OR C__c=3)"), key(prefix + "(A__c=1 AND B__c=2) OR C__c=3"));
    assert.notEqual(key(prefix + "A__c=1 AND B__c=2"), key(prefix + "A__c=1 OR B__c=2"));
  });
  await t.test("subqueries, functions, escaped literals and IN predicates retain boundaries", () => {
    assert.equal(key("SELECT COUNT(Id), Name FROM Account"), key("SELECT Name, count( id ) FROM Account"));
    assert.equal(key("SELECT Id, (SELECT Id, Name FROM Contacts WHERE A__c=1 AND B__c=2) FROM Account"), key("SELECT (SELECT Name, Id FROM Contacts WHERE B__c=2 AND A__c=1), Id FROM Account"));
    assert.equal(key("SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM Contact WHERE A__c=1 AND B__c=2)"), key("SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM Contact WHERE B__c=2 AND A__c=1)"));
    const literal = "'O\\'Brien AND from User'";
    assert.equal(key(`SELECT Id, Name FROM Account WHERE Name=${literal} AND A__c=1`), key(`SELECT Name,Id FROM Account WHERE A__c=1 AND Name = ${literal}`));
    assert.notEqual(key("SELECT Id FROM Account WHERE Name IN ('a,b', 'c')"), key("SELECT Id FROM Account WHERE Name IN ('a', 'b,c')"));
  });
  await t.test("differences affecting results never collapse", () => {
    const query = "SELECT Id, Name FROM Account WHERE Name='Manual Creation' AND A__c=1";
    for (const different of [
      query.replace("Id, Name", "Id"),
      query.replace("Account", "Contact"),
      query.replace("A__c=1", "A__c=2"),
      query.replace("A__c=1", "B__c=1"),
      query.replace("A__c=1", "A__c!=1"),
      query.replace("Manual Creation", "Manual  Creation"),
      query.replace("Manual Creation", "manual Creation"),
      query + " LIMIT 1",
      query + " OFFSET 1",
      query + " WITH SECURITY_ENFORCED",
      query + " ALL ROWS"
    ]) { assert.notEqual(key(query), key(different), different); }
    assert.notEqual(key(query + " ORDER BY Id, Name"), key(query + " ORDER BY Name, Id"));
    assert.notEqual(key(query + " ORDER BY Id ASC"), key(query + " ORDER BY Id DESC"));
    assert.notEqual(key("SELECT Id FROM Account WHERE A__c=10"), key("SELECT Id FROM Account WHERE A__c=1 0"));
    assert.notEqual(historyKey({query, useToolingApi: true}), key(query));
  });
  await t.test("unknown and malformed syntax falls back to compacted text without reordering", () => {
    for (const query of ["FIND {hello} RETURNING Account(Id)", "SELECT Id FROM Account WHERE Name='broken", "SELECT Id FROM Account WHERE (A__c=1", "SELECT TYPEOF Owner WHEN User THEN Name END FROM Account", "SELECT Id FROM Account WHERE Id=:binding"]) {
      assert.notEqual(key(query), key(query + " LIMIT 1"));
    }
    assert.equal(key("SELECT  Id FROM Account WHERE Id=:binding"), key(" SELECT Id FROM Account WHERE Id=:binding "));
    const history = new QueryHistory("insextQueryHistory", 100, memoryStorage(null));
    const entry = {query: "  SELECT  Id FROM Account WHERE Id=:binding  "};
    history.add(entry);
    assert.equal(history.remove(entry), true);
  });
  await t.test("legacy duplicates collapse newest-first and persist on next success", () => {
    const newest = {query: latest, lastExecutedAt: 3};
    const older = {query: first};
    const tooling = {...older, useToolingApi: true};
    const storage = memoryStorage(JSON.stringify([newest, older, tooling]));
    const history = new QueryHistory("insextQueryHistory", 100, storage);
    assert.deepEqual(history.list, [{...newest, runCount: 2}, tooling]);
    history.add({query: "SELECT Id FROM Contact", lastExecutedAt: 4});
    assert.equal(JSON.parse(storage.getItem()).length, 3);
    assert.equal(history.remove(older), true);
    assert.deepEqual(history.list, [{query: "SELECT Id FROM Contact", lastExecutedAt: 4, runCount: 1}, tooling]);
  });
  await t.test("failed equivalent replacement does not publish the new version", () => {
    const original = {query: first, lastExecutedAt: 1};
    const storage = memoryStorage(JSON.stringify([original]));
    const history = new QueryHistory("insextQueryHistory", 100, storage);
    storage.setItem = () => { throw new Error("quota"); };
    assert.throws(() => history.add({query: latest, lastExecutedAt: 2}));
    assert.deepEqual(history.list, [original]);
    assert.deepEqual(JSON.parse(storage.getItem()), [original]);
  });
  await t.test("manual saved queries retain their exact text and labels", () => {
    const history = new QueryHistory("insextSavedQueryHistory", 100, memoryStorage(null));
    history.add({query: first, label: "first"});
    history.add({query: latest, label: "latest"});
    assert.equal(history.list.length, 2);
  });
});

test("query history data and tab integration", async t => {
  "use strict";
  const {QueryHistory, filterHistory, queryObject, querySummary, previewTokens, queryBaseline, compactQueryWhitespace} = await import("../addon/query-history.js");
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
  const Model = new Function("queryBaseline", "compactQueryWhitespace", "localStorage", body + "\nreturn Model;")(queryBaseline, compactQueryWhitespace, storage);
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
  await t.test("manual save compacts query whitespace and preserves the query name and editor", () => {
    const vm = model();
    vm.queryName = "My  query";
    vm.queryInput.value = "  SELECT  Name, Id\n FROM Account WHERE Name = 'A  B'  ";
    vm.savedHistory = new QueryHistory("insextSavedQueryHistory", 100, memoryStorage(null));
    vm.addToHistory();
    assert.equal(vm.savedHistory.list[0].query, "My  query:SELECT Name, Id FROM Account WHERE Name = 'A  B'");
    assert.equal(vm.queryInput.value, "  SELECT  Name, Id\n FROM Account WHERE Name = 'A  B'  ");
    vm.removeFromHistory();
    assert.equal(vm.savedHistory.list.length, 0);
    vm.savedHistory.add({query: "My  query:" + vm.queryInput.value.trim(), useToolingApi: false});
    vm.removeFromHistory();
    assert.equal(vm.savedHistory.list.length, 0);
    vm.queryName = "";
    assert.equal(vm.getQueryToSave(), "SELECT Name, Id FROM Account WHERE Name = 'A  B'");
  });
  await t.test("actual export success replaces equivalent text and results; failure preserves history", async () => {
    class ExportRecords {
      constructor() { this.records = []; this.totalSize = -1; }
      addToTable(records) { this.records.push(...records); }
    }
    const first = "SELECT Id, Name FROM User WHERE IsActive=true AND RP_StatusEventType__c='Manual Creation'";
    const latest = "  SELECT  Name, Id\nFROM User WHERE RP_StatusEventType__c='Manual Creation'  AND IsActive=true  ";
    const record = {Id: "005example", Name: "Latest", attributes: {type: "User"}};
    const failure = Object.assign(new Error("Query failed"), {name: "SalesforceRestError"});
    const responses = [{records: [], done: true, totalSize: 0}, {records: [record], done: true, totalSize: 1}, failure];
    const conn = {rest() {
      const response = responses.shift();
      return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
    }};
    const templateRuns = [];
    const ExportModel = new Function("recordTemplateRun", "queryBaseline", "localStorage", "RecordTable", "sfConn", "s", body + "\nreturn Model;")(id => templateRuns.push(id), queryBaseline, storage, ExportRecords, conn, count => count === 1 ? "" : "s");
    const vm = model();
    Object.setPrototypeOf(vm, ExportModel.prototype);
    Object.assign(vm, {
      queryHistory: new QueryHistory("insextQueryHistory", 100, memoryStorage(null)),
      initPerf() {},
      markPerf() {},
      setResultsFilter() {},
      updateCurrentTabName() {},
      saveQueryTabs() {},
      setQueryMethod(data) { data.queryMethod = "query"; },
      spinFor(promise) { this.pendingExport = promise; }
    });
    vm.queryInput.value = first;
    vm.queryTabs[0].templateSource = {id: "test-template", query: first, tooling: false};
    vm.doExport();
    await vm.pendingExport;
    assert.equal(vm.queryHistory.list.length, 1);
    assert.deepEqual(templateRuns, ["test-template"]);
    vm.queryInput.value = latest;
    vm.queryTabs[0].templateSource.query = latest;
    vm.doExport();
    await vm.pendingExport;
    assert.equal(vm.queryHistory.list.length, 1);
    assert.equal(vm.queryHistory.list[0].query, compactQueryWhitespace(latest));
    assert.equal(vm.queryInput.value, latest);
    assert.equal(vm.queryTabs[0].baseline, queryBaseline(latest, false, true));
    assert.deepEqual(vm.queryTabs[0].results.records, [record]);
    const saved = JSON.stringify(vm.queryHistory.list);
    vm.queryInput.value = first;
    vm.queryTabs[0].templateSource = {id: "test-template", query: first, tooling: false};
    vm.doExport();
    await vm.pendingExport;
    assert.equal(vm.exportError, "Query failed");
    assert.deepEqual(templateRuns, ["test-template", "test-template"]);
    assert.equal(vm.queryHistory.list[0].runCount, 2);
    assert.equal(JSON.stringify(vm.queryHistory.list), saved);
  });
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
  const {QueryLibraryBrowser} = await import("../addon/query-library-browser.js");
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
    const browser = new QueryLibraryBrowser(component.libraryProps());
    Object.defineProperty(browser, "props", {get: () => component.libraryProps()});
    Object.defineProperty(browser, "search", {get: () => component.search.current});
    return {model, component, browser};
  }
  await t.test("reopening after Enter preserves search, filtered options and selection", () => {
    const {model, component, browser} = panel();
    const c = {query: "SELECT Name FROM Account", useToolingApi: false};
    model.queryHistory.add(c);
    browser.changeSearch("account");
    browser.props.onSelect(a);
    const rows = component.rows();
    browser.navigate({key: "Enter", target: component.search.current, preventDefault() {}, stopPropagation() {}});
    assert.equal(model.runs, 1);
    assert.equal(component.state.open, false);
    let focused = false;
    let selection = [0, 0];
    component.search.current = {
      value: component.state.search,
      focus() { focused = true; selection = [0, this.value.length]; },
      setSelectionRange(start, end) { selection = [start, end]; }
    };
    component.toggle();
    assert.equal(component.state.open, true);
    assert.equal(component.state.search, "account");
    assert.deepEqual(component.rows(), rows);
    assert.equal(component.state.selected, historyKey(a));
    assert.deepEqual(component.selected(), a);
    assert.equal(focused, true);
    assert.deepEqual(selection, ["account".length, "account".length]);
  });
  await t.test("reopening refreshes history and falls back within the saved filter", () => {
    const {model, component, browser} = panel();
    const c = {query: "SELECT Name FROM Account", useToolingApi: false};
    model.queryHistory.add(c);
    browser.changeSearch("account");
    browser.props.onSelect(a);
    component.close();
    model.queryHistory.storage.setItem("history", JSON.stringify([b, c]));
    component.toggle();
    assert.equal(component.state.search, "account");
    assert.deepEqual(component.rows(), [c]);
    assert.deepEqual(component.selected(), c);
    component.close();
    model.queryHistory.storage.setItem("history", JSON.stringify([b]));
    component.toggle();
    assert.equal(component.state.search, "account");
    assert.deepEqual(component.rows(), []);
    assert.equal(component.state.selected, null);
    assert.equal(component.selected(), undefined);
  });
  await t.test("equivalent replacement preserves selection and loads the latest original", () => {
    const {model, component} = panel();
    const latest = {query: " select id from account ", useToolingApi: false, lastExecutedAt: 50};
    model.queryHistory.add(latest);
    component.refresh();
    assert.equal(component.state.selected, historyKey(a));
    assert.deepEqual(component.selected(), latest);
    component.load(true);
    assert.deepEqual(model.loads, [{entry: latest, newTab: true}]);
  });
  await t.test("search resets scroll after filtering and keeps input focused for continued typing", () => {
    const {component, browser} = panel();
    let focused = 0;
    const list = {scrollTop: 420, focus() { focused++; }};
    component.search.current = {};
    global.document = {activeElement: component.search.current};
    browser.list = list;
    component.state.selected = historyKey(b);
    browser.changeSearch("中文Acc");
    browser.changeSearch("中文Account");
    assert.equal(component.state.search, "Account");
    assert.equal(component.state.selected, historyKey(a));
    assert.equal(list.scrollTop, 0);
    assert.equal(focused, 0);
    assert.equal(document.activeElement, component.search.current);
    list.scrollTop = 200;
    browser.changeSearch("Account Id");
    assert.equal(component.state.search, "Account Id");
    assert.equal(list.scrollTop, 0);
    browser.changeSearch("missing");
    component.close();
  });
  function actionButton(component, label) {
    global.window = {innerWidth: 1280, innerHeight: 900};
    function find(node) {
      if (Array.isArray(node)) { return node.map(find).find(Boolean); }
      if (!node || typeof node !== "object") { return null; }
      return node.type === "button" && node.props.children === label ? node : find(node.props?.children);
    }
    return find(component.render());
  }
  await t.test("history actions match Enter exactly except for the new tab target and never confirm replacement", () => {
    const results = [];
    for (const action of ["Enter", "Load query", "Open in new tab"]) {
      const {model, component, browser} = panel();
      const calls = [];
      model.hasQueryEdits = () => { throw new Error("History must overwrite directly"); };
      model.loadHistoryQuery = (entry, newTab) => calls.push({entry, newTab});
      model.queryInput.focus = () => calls.push("focus");
      model.doExport = () => calls.push("run");
      model.didUpdate = () => calls.push("update");
      component.state.search = "account";
      if (action === "Enter") {
        component.search.current = {};
        browser.navigate({key: "Enter", target: component.search.current, preventDefault() {}, stopPropagation() {}});
      } else {
        actionButton(component, action).props.onClick();
      }
      assert.deepEqual(calls, [{entry: a, newTab: action === "Open in new tab"}, "focus", "run", "update"]);
      assert.equal(component.state.error, "");
      results.push({calls: calls.slice(1), state: {...component.state}});
    }
    assert.deepEqual(results[1], results[0]);
    assert.deepEqual(results[2], results[0]);
  });
  for (const [label, newTab] of [["Load query", false], ["Open in new tab", true]]) {
    await t.test(`${label} loads and runs once, closes and focuses the editor even with edits`, () => {
      const {model, component} = panel();
      const actions = [];
      model.queryInput.focus = () => actions.push("focus");
      model.loadHistoryQuery = (entry, target) => actions.push({entry, newTab: target});
      model.doExport = () => actions.push("run");
      actionButton(component, label).props.onClick();
      assert.deepEqual(actions, [{entry: a, newTab}, "focus", "run"]);
      assert.equal(component.state.open, false);
    });
    await t.test(`${label} is disabled and does not load or run when busy or empty`, () => {
      for (const busy of [true, false]) {
        const {model, component} = panel();
        model.isWorking = busy;
        if (!busy) { component.state.search = "missing"; }
        const button = actionButton(component, label);
        assert.equal(button.props.disabled, true);
        button.props.onClick();
        assert.equal(model.loads.length, 0);
        assert.equal(model.runs, 0);
        assert.equal(component.state.open, true);
      }
    });
    await t.test(`${label} keeps the panel open and does not run when loading fails`, () => {
      const {model, component} = panel();
      model.loadHistoryQuery = () => { throw new Error("quota"); };
      actionButton(component, label).props.onClick();
      assert.equal(model.runs, 0);
      assert.equal(component.state.open, true);
      assert.ok(component.state.error);
    });
  }
  await t.test("arrows select without loading; Enter loads, runs and closes even with editor changes", () => {
    let {model, component, browser} = panel();
    const search = {dataset: {}};
    component.search.current = search;
    component.root.current = {querySelector: () => null};
    let prevented = 0;
    let event = key => ({key, target: search, preventDefault() { prevented++; }, stopPropagation() {}});
    browser.navigate(event("ArrowDown"));
    assert.equal(component.state.selected, historyKey(b));
    assert.equal(model.loads.length, 0);
    browser.navigate(event("ArrowUp"));
    assert.equal(component.state.selected, historyKey(a));
    browser.navigate(event("Enter"));
    assert.deepEqual(model.loads, [{entry: a, newTab: false}]);
    assert.equal(model.runs, 1);
    assert.equal(component.state.open, false);
    assert.equal(prevented, 3);
  });
  await t.test("Enter on a row runs once; empty, busy and composing states do not run", () => {
    let {model, component, browser} = panel();
    const event = {key: "Enter", target: {dataset: {queryLibraryRow: "true"}}, preventDefault() {}, stopPropagation() {}};
    browser.navigate({...event, isComposing: true});
    assert.equal(model.runs, 0);
    model.isWorking = true;
    browser.navigate(event);
    assert.equal(model.runs, 0);
    model.isWorking = false;
    component.state.search = "missing";
    browser.navigate(event);
    assert.equal(model.runs, 0);
    component.state.search = "";
    browser.navigate(event);
    assert.equal(model.runs, 1);
  });
  await t.test("candidate rendering omits empty clauses and has no Undo control", () => {
    let {component} = panel();
    global.window = {innerWidth: 1280, innerHeight: 900};
    const tree = component.render();
    const nodes = [];
    function visit(node) {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (!node || typeof node !== "object") { return; }
      nodes.push(node);
      if (typeof node.type === "function") { const Component = node.type; visit(new Component(node.props).render()); }
      visit(node.props?.children);
    }
    visit(tree);
    assert.equal(nodes.filter(node => node.type === QueryLibraryBrowser).length, 1);
    const candidates = nodes.filter(node => node.props?.className === "history-select");
    assert.equal(candidates.length, 2);
    assert.deepEqual(candidates[0].props.children[1].props.children.props.children.filter(Boolean).map(row => row.props.children), ["Id", "Account"]);
    assert.equal(nodes.some(node => node.type === "button" && String(node.props.children).includes("Undo")), false);
  });
  await t.test("deletion updates selection and preview before lifecycle reconciliation", () => {
    const c = {query: "SELECT Name FROM Account", useToolingApi: false};
    const d = {query: "SELECT Email__c FROM Account", useToolingApi: false};
    for (const scenario of [
      {items: [a, c, d], selected: c, deleted: c, expected: d},
      {items: [a, c, d], selected: d, deleted: d, expected: c},
      {items: [a], selected: a, deleted: a, expected: null},
      {items: [a, c, d], selected: c, deleted: a, expected: c},
      {items: [a, b, c, d], search: "account", selected: c, deleted: c, expected: d}
    ]) {
      const {model, component, browser} = panel();
      model.queryHistory = new QueryHistory("history", 100, memoryStorage(JSON.stringify(scenario.items)));
      component.state.search = scenario.search || "";
      component.state.selected = historyKey(scenario.selected);
      component.setState = (next, callback) => {
        Object.assign(component.state, typeof next === "function" ? next(component.state) : next);
        component.componentDidUpdate();
        callback?.();
      };
      let focusedSelection;
      const focus = () => { focusedSelection = component.state.selected; };
      component.root.current = {querySelector: () => component.selected() ? {focus} : null};
      component.search.current = {focus};
      component.delete(scenario.deleted);
      const expectedKey = scenario.expected ? historyKey(scenario.expected) : null;
      assert.equal(component.state.selected, expectedKey);
      assert.equal(focusedSelection, expectedKey);
      assert.deepEqual(component.selected(), scenario.expected || undefined);
      const nodes = [];
      function visit(node) {
        if (Array.isArray(node)) { node.forEach(visit); return; }
        if (!node || typeof node !== "object") { return; }
        nodes.push(node);
        visit(node.props?.children);
      }
      global.window = {innerWidth: 1280, innerHeight: 900};
      visit(component.render());
      visit(browser.render());
      const preview = nodes.find(node => node.type === "pre").props.children;
      assert.equal(Array.isArray(preview) ? preview.map(token => token.props.children).join("").replace(/\s+/g, " ") : preview,
        scenario.expected?.query || "Select a query to preview");
      assert.equal(nodes.filter(node => node.props?.["data-selected"]).length, scenario.expected ? 1 : 0);
    }
  });
  await t.test("Delete on a history option deletes it and selects the next option", () => {
    const {model, component, browser} = panel();
    function findOption(node) {
      if (Array.isArray(node)) { return node.map(findOption).find(Boolean); }
      if (!node || typeof node !== "object") { return undefined; }
      return node.props?.["data-query-library-row"] ? node : findOption(node.props?.children);
    }
    const option = findOption(browser.render());
    option.props.onClick();
    browser.navigate({key: "Delete", target: {dataset: {queryLibraryRow: "true"}}, preventDefault() {}, stopPropagation() {}});
    assert.deepEqual(model.queryHistory.list, [b]);
    assert.deepEqual(component.selected(), b);
    assert.equal(component.state.open, true);
    assert.equal(model.runs, 0);
  });
  await t.test("Delete after arrow selection from search uses the same deletion and preview state", () => {
    const {model, component, browser} = panel();
    const c = {query: "SELECT Id FROM Case", useToolingApi: false};
    model.queryHistory.storage.setItem("history", JSON.stringify([a, b, c]));
    model.queryHistory.refresh();
    component.search.current = {};
    const event = {target: component.search.current, preventDefault() {}, stopPropagation() {}};
    browser.navigate({...event, key: "ArrowDown"});
    assert.deepEqual(component.selected(), b);
    browser.navigate({...event, key: "Delete"});
    assert.deepEqual(model.queryHistory.list, [a, c]);
    assert.deepEqual(component.selected(), c);
    assert.equal(component.state.open, true);
    assert.equal(model.runs, 0);
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

test("history ranks match location first and usage second without mutating storage order", async () => {
  "use strict";
  const {filterHistory, englishSearch} = await import("../addon/query-history.js");
  const rows = [
    {query: "SELECT Id FROM CaseHistory", runCount: 50},
    {query: "SELECT Name FROM Case", runCount: 2},
    {query: "SELECT Id FROM Case", runCount: 7},
    {query: "SELECT Id FROM BriefcaseAssignment", runCount: 100}
  ];
  assert.deepEqual(filterHistory(rows, "case").map(e => e.runCount), [100, 50, 7, 2]);
  assert.deepEqual(filterHistory(rows, ""), rows);
  assert.deepEqual(filterHistory(rows, "   "), rows);
  assert.equal(rows[0].runCount, 50);
  assert.equal(englishSearch("中文Account Id_1 = 'Hi'，😀"), "Account Id_1 = 'Hi'");
});


test("history prioritizes objects, selected fields, WHERE fields and other text", async () => {
  "use strict";
  global.React = require("../addon/react.js");
  const {filterHistory, historySearchTexts} = await import("../addon/query-history.js");
  const {QueryHistoryPanel} = await import("../addon/query-history-panel.js");
  const rows = [
    {query: "SELECT Id FROM Account WHERE Name = 'Needle'", runCount: 100},
    {query: "SELECT Id FROM Account WHERE Needle__c = 'yes'", runCount: 80},
    {query: "SELECT Needle__c FROM Account", runCount: 50},
    {query: "SELECT Id FROM Needle", runCount: 1},
    {query: "SELECT COUNT(Needle__c) total FROM Account", runCount: 60},
    {query: "SELECT Id FROM Account ORDER BY Needle__c", runCount: 200},
    {query: "SELECT Id FROM MyNeedle__c", runCount: 2}
  ];
  const expected = [rows[6], rows[3], rows[4], rows[2], rows[1], rows[5], rows[0]];
  assert.deepEqual(filterHistory(rows, " NeEdLe "), expected);
  assert.deepEqual(filterHistory(rows, "needle account"), [rows[5], rows[0], rows[1], rows[4], rows[2]]);
  assert.deepEqual(filterHistory(rows, "absent"), []);
  const panel = new QueryHistoryPanel({model: {queryHistory: {list: rows}}});
  assert.deepEqual(panel.rows(), rows);
  panel.state.search = "needle";
  assert.deepEqual(panel.rows(), expected);
  panel.state.search = "";
  assert.deepEqual(panel.rows(), rows);
  const query = "SELECT COUNT(Id) Needle, (SELECT Account.Name FROM Contacts WHERE DAY_ONLY(CreatedDate) > 2026-01-01) FROM Account WHERE (Name = 'Needle' OR Owner.Name = 'from where') AND Id IN (SELECT AccountId FROM Opportunity WHERE StageName = 'Needle') ORDER BY Needle__c /* Needle */";
  const [objects, fields, whereFields] = historySearchTexts({query});
  assert.equal(objects, "Contacts Account Opportunity");
  assert.equal(fields, "Id Account.Name AccountId");
  assert.equal(whereFields, "CreatedDate Name Owner.Name Id StageName");
  assert.deepEqual(filterHistory([{query: "FIND {Needle}"}], "needle"), [{query: "FIND {Needle}"}]);
});
