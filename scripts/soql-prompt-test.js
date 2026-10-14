const assert = require("node:assert/strict");
const {test} = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

const settle = () => {
  "use strict";
  return new Promise(resolve => setImmediate(resolve));
};

test("SOQL prompt context, configuration and asynchronous interactions", async () => {
  "use strict";
  const {soqlPromptTest} = await import("../addon/soql-prompt-test.js");
  await soqlPromptTest({assert: value => assert.ok(value), assertEquals: (expected, actual) => assert.deepEqual(actual, expected)});
});

test("the adapter shares the real DescribeInfo cache and preserves synchronous statuses", async () => {
  "use strict";
  global.localStorage = {getItem: () => null};
  global.window = {location: {href: "data-export.html"}};
  const {sfConn} = await import("../addon/inspector.js");
  const {DescribeInfo} = await import("../addon/data-load.js");
  const {SoqlMetadata} = await import("../addon/soql-metadata.js");
  const {promptFixtures} = await import("../addon/soql-prompt-test.js");
  const originalRest = sfConn.rest;
  const requests = [];
  const pending = [];
  sfConn.rest = url => {
    requests.push(url);
    return new Promise((resolve, reject) => pending.push({resolve, reject}));
  };
  const cache = new DescribeInfo(() => {}, () => {});
  const metadata = new SoqlMetadata(cache);
  const objects = [...promptFixtures().values()].map(object => ({...object, urls: {describe: `/describe/${object.name}`}}));
  try {
    assert.equal(cache.describeGlobal(false).globalStatus, "loading");
    const first = metadata.loadObjects();
    const second = metadata.loadObjects();
    assert.equal(requests.length, 1);
    pending.shift().resolve({sobjects: objects});
    assert.equal((await first).length, 4);
    assert.deepEqual(await first, await second);
    assert.equal(cache.describeGlobal(false).globalStatus, "ready");
    assert.equal(cache.describeSobject(false, "User").sobjectStatus, "loading");
    const user = metadata.loadObject("User");
    assert.equal(requests.length, 2);
    pending.shift().resolve(promptFixtures().get("User"));
    assert.equal((await user).name, "User");
    assert.equal(cache.describeSobject(false, "User").sobjectStatus, "ready");
    assert.equal(cache.describeSobject(false, "Missing").sobjectStatus, "notfound");
    await assert.rejects(metadata.loadObject("Missing"), /not available/);

    const failed = metadata.loadObject("Profile");
    pending.shift().reject(new Error("permission denied"));
    await assert.rejects(failed, /Could not load Profile/);
    assert.equal(cache.describeSobject(false, "Profile").sobjectStatus, "loadfailed");
    cache.reloadAll();
    const refreshed = metadata.loadObjects();
    pending.shift().resolve({sobjects: objects});
    await refreshed;
    assert.equal(cache.describeSobject(false, "UserRole").sobjectStatus, "loading");
    const oldRole = pending.shift();
    cache.reloadAll();
    const role = metadata.loadObject("UserRole");
    pending.shift().resolve({sobjects: objects});
    await settle();
    oldRole.resolve({name: "StaleRole", fields: []});
    await settle();
    assert.equal(cache.describeSobject(false, "UserRole").sobjectStatus, "loading");
    pending.shift().resolve(promptFixtures().get("UserRole"));
    assert.equal((await role).name, "UserRole");
    assert(requests.every(url => !url.includes("tooling") && !url.includes("gemini")));
  } finally {
    sfConn.rest = originalRest;
  }
});

test("clipboard reports actual copy events and preserves legacy failure feedback", async () => {
  "use strict";
  global.parent = {};
  const {copyToClipboard} = await import("../addon/data-load.js");
  let element;
  let clipboard;
  let focusRestored = 0;
  let alerts = 0;
  const children = new Set();
  global.alert = () => { alerts++; };
  global.document = {
    activeElement: {focus: () => { focusRestored++; }},
    createElement: () => {
      element = {addEventListener: (event, listener) => { element[event] = listener; }, select: () => {}};
      return element;
    },
    body: {appendChild: child => children.add(child), removeChild: child => children.delete(child)},
    execCommand: () => {
      element.copy({clipboardData: {setData: (format, value) => { clipboard = [format, value]; }}, preventDefault() {}});
      return true;
    }
  };
  assert.equal(copyToClipboard("完整\nprompt", {notifyFailure: false}), true);
  assert.deepEqual(clipboard, ["text/plain", "完整\nprompt"]);
  assert.equal(children.size, 0);
  assert.equal(focusRestored, 1);
  document.execCommand = () => false;
  assert.equal(copyToClipboard("failed", {notifyFailure: false}), false);
  assert.equal(alerts, 0);
  assert.equal(copyToClipboard("legacy failure"), false);
  assert.equal(alerts, 1);
  document.execCommand = () => true;
  assert.equal(copyToClipboard("no event", {notifyFailure: false}), false);
  document.execCommand = () => { throw new Error("blocked"); };
  assert.throws(() => copyToClipboard("exception", {notifyFailure: false}), /blocked/);
  assert.equal(children.size, 0);
  global.parent = {isUnitTest: true};
  assert.equal(copyToClipboard("unit test"), true);
  assert.equal(parent.testClipboardValue, "unit test");
});

test("Data Export integrates drafts without mutating queries, results or persisted tab structure", async () => {
  "use strict";
  const {memoryStorage, promptFixtures} = await import("../addon/soql-prompt-test.js");
  const {CommonFieldsStore} = await import("../addon/soql-common-fields.js");
  global.localStorage = memoryStorage();
  localStorage.insextQueryHistory = "[]";
  localStorage.insextSavedQueryHistory = "[]";
  global.window = {location: {href: "data-export.html"}};
  global.addEventListener = () => {};
  global.React = {Component: class {}, createElement: () => {}};
  global.parent = {isUnitTest: true};
  const {sfConn} = await import("../addon/inspector.js");
  const originalRest = sfConn.rest;
  const originalSoap = sfConn.soap;
  const describes = promptFixtures();
  const requests = [];
  sfConn.soap = async () => ({userFullName: "Fixture User", userName: "fixture@example.com", organizationName: "Fixture Org"});
  sfConn.rest = async url => {
    requests.push(url);
    if (url.endsWith("/sobjects/")) {
      return {sobjects: [...describes.values()].map(object => ({...object, urls: {describe: `/describe/${object.name}`}}))};
    }
    assert(url.startsWith("/describe/"), `Unexpected request: ${url}`);
    return describes.get(url.split("/").at(-1));
  };
  const addonRoot = path.resolve(__dirname, "../addon");
  let source = await fs.readFile(path.join(addonRoot, "data-export.js"), "utf8");
  // Expose the existing classes while omitting only the extension-page bootstrap.
  source = source.replace(/\n\{\n\n {2}let args = new URLSearchParams\(location.search\);[\s\S]*?\n\}\n\nfunction getSeparator/, "\nfunction getSeparator");
  source = source.replace(/from "(\.\/[^"]+)"/g, (match, file) => `from "${pathToFileURL(path.join(addonRoot, file)).href}"`);
  source += "\nexport {Model};\n";
  try {
    const {Model} = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
    const model = new Model({sfHost: "fixture.example", args: new URLSearchParams()});
    const query = {value: "", selectionStart: 7, selectionEnd: 7, focus() {}};
    model.setQueryInput(query);
    model.resultTableCallback = () => {};
    await settle();
    assert.equal(query.value, "SELECT Id FROM Account LIMIT 200");
    const results = {records: [{Id: "fixture-record"}]};
    model.exportedData = results;
    model.queryTabs[0].results = results;
    const assistant = model.soqlAssistant;
    new CommonFieldsStore(model.sfHost, localStorage).save("User", ["Name", "IsActive", "Profile.Name"]);
    await assistant.toggle(query.value);
    await assistant.selectObject("User");
    await assistant.setRequest("查询 User 关键字段");
    await assistant.copy();
    assert.equal(query.value, "SELECT Id FROM Account LIMIT 200");
    assert.equal(model.exportedData, results);
    assert.equal(model.isWorking, false);
    assert.equal(model.queryTooling, false);
    assert(!parent.testClipboardValue.includes("fixture-record"));
    assert(!parent.testClipboardValue.includes("fixture@example.com"));
    const firstTab = model.queryTabs[0];
    model.addQueryTab();
    assert.equal(query.value, "");
    await assistant.toggle(query.value);
    await assistant.selectObject("Account");
    await assistant.setRequest("查询 Name");
    model.setActiveTab(0);
    await settle();
    assert.equal(model.queryTabs[0], firstTab);
    assert.equal(assistant.draft.object, "User");
    assert.equal(assistant.draft.request, "查询 User 关键字段");
    assert.equal(model.exportedData, results);
    assert.equal(query.value, firstTab.query);
    model.queryTooling = true;
    model.updateCurrentTabProperty("queryTooling", true);
    model.queryAutocompleteHandler();
    assert.equal(assistant.canCopy, false);
    model.queryTooling = false;
    model.updateCurrentTabProperty("queryTooling", false);
    model.queryAutocompleteHandler();
    await settle();
    assert.equal(assistant.canCopy, true);
    query.value = "SELECT Id, Name FROM User";
    model.updateCurrentTabQuery(query.value);
    model.queryAutocompleteHandler();
    model.setActiveTab(1);
    model.setActiveTab(0);
    await settle();
    assert.equal(query.value, "SELECT Id, Name FROM User");
    const saved = JSON.parse(localStorage.getItem(`${model.sfHost}_queryTabs`));
    assert.equal(saved[0].query, query.value);
    assert.deepEqual(Object.keys(saved[0]).sort(), ["name", "query", "queryAll", "queryTooling"]);
    await assistant.toggle(query.value);
    assert.equal(query.value, "SELECT Id, Name FROM User");
    assert.equal(model.exportedData, results);
    assert(requests.every(url => url.endsWith("/sobjects/") || url.startsWith("/describe/")));
    assistant.dispose();
  } finally {
    sfConn.rest = originalRest;
    sfConn.soap = originalSoap;
  }
});
