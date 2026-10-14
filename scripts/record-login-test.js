const assert = require("node:assert/strict");
const {test} = require("node:test");
const fs = require("node:fs/promises");
const {pathToFileURL} = require("node:url");
const path = require("node:path");

test("Data Export record login actions", async t => {
  "use strict";
  global.localStorage = {getItem: () => null};
  global.window = {location: {href: "data-export.html"}};
  const inspectorUrl = pathToFileURL(path.resolve(__dirname, "../addon/inspector.js"));
  const {sfConn} = await import(inspectorUrl.href);
  const {getRecordLoginLinks} = await import("../addon/record-login.js");
  const userId = "005000000000001AAA";
  const contactId = "003000000000001AAA";
  const userInfo = Promise.resolve({organizationId: "00D000000000001AAA", userId: "005000000000002AAA"});
  const calls = [];
  let responses;
  sfConn.rest = async url => {
    calls.push(decodeURIComponent(url));
    const response = responses.shift();
    if (response instanceof Error) {
      throw response;
    }
    assert.ok(response, "Unexpected API request");
    return response;
  };
  const reset = (...results) => {
    calls.length = 0;
    responses = results;
  };
  const activeUser = {records: [{Id: userId, IsActive: true}]};

  await t.test("active User ID opens the existing Salesforce login endpoint", async () => {
    reset(activeUser);
    const links = await getRecordLoginLinks("example.my.salesforce.com", userId, userInfo);
    assert.equal(links.length, 1);
    assert.equal(links[0].label, "Login As");
    const url = new URL(links[0].href);
    assert.equal(url.origin, "https://example.my.salesforce.com");
    assert.equal(url.pathname, "/servlet/servlet.su");
    assert.equal(url.searchParams.get("oid"), "00D000000000001AAA");
    assert.equal(url.searchParams.get("suorgadminid"), userId);
    assert.equal(url.searchParams.get("retURL"), "/" + userId);
    assert.equal(url.searchParams.get("targetURL"), "/");
  });
  await t.test("15-character IDs work", async () => {
    reset(activeUser);
    assert.equal((await getRecordLoginLinks("example.com", userId.slice(0, 15), userInfo)).length, 1);
  });
  await t.test("inactive, missing and current users have no login action", async () => {
    for (const result of [{records: []}, {records: [{Id: userId, IsActive: false}]}, activeUser]) {
      reset(result);
      const currentUser = Promise.resolve({organizationId: "00D000000000001AAA", userId: userId.slice(0, 15)});
      assert.deepEqual(await getRecordLoginLinks("example.com", userId, currentUser), []);
    }
  });
  await t.test("other objects and malformed IDs require no API requests", async () => {
    reset();
    for (const id of [null, "001000000000001AAA", "005000000000001A", "005000000000001' OR IsActive = true"]) {
      assert.deepEqual(await getRecordLoginLinks("example.com", id, userInfo), []);
    }
    assert.equal(calls.length, 0);
  });
  await t.test("active Contact user logs into its Experience site", async () => {
    reset(activeUser, {records: [{NetworkId: "0DB000000000001AAA", Network: {Name: "Customer site"}}]});
    const links = await getRecordLoginLinks("example.com", contactId, userInfo);
    assert.equal(links[0].label, "Log in to Experience as User");
    const url = new URL(links[0].href);
    assert.equal(url.searchParams.get("sunetworkuserid"), userId);
    assert.equal(url.searchParams.get("sunetworkid"), "0DB000000000001AAA");
    assert.equal(url.searchParams.get("retURL"), "/" + contactId);
    assert.equal(url.searchParams.has("suorgadminid"), false);
    assert.match(calls[0], /IsActive = true AND IsPortalEnabled = true AND ContactId/);
  });
  await t.test("Contacts without active users or site membership have no action", async () => {
    reset({records: []});
    assert.deepEqual(await getRecordLoginLinks("example.com", contactId, userInfo), []);
    assert.equal(calls.length, 1);
    reset(activeUser, {records: []});
    assert.deepEqual(await getRecordLoginLinks("example.com", contactId, userInfo), []);
  });
  await t.test("multiple Experience sites are selectable", async () => {
    reset(activeUser, {records: [
      {NetworkId: "0DB000000000001AAA", Network: {Name: "Customers"}},
      {NetworkId: "0DB000000000002AAA", Network: {Name: "Partners"}}
    ]});
    const links = await getRecordLoginLinks("example.com", contactId, userInfo);
    assert.deepEqual(links.map(link => link.label), ["Log in to Experience as User (Customers)", "Log in to Experience as User (Partners)"]);
    assert.notEqual(links[0].href, links[1].href);
  });
  await t.test("missing organization context cannot generate an invalid login URL", async () => {
    reset(activeUser);
    assert.deepEqual(await getRecordLoginLinks("example.com", userId, Promise.resolve({})), []);
  });

  // Exercise the real menu renderer using a minimal DOM, without a Salesforce session.
  class Element {
    constructor() {
      this.children = [];
      this.listeners = {};
      this.isConnected = true;
    }
    appendChild(child) {
      this.children.push(child);
      child.parent = this;
    }
    prepend(child) {
      this.children.unshift(child);
    }
    addEventListener(name, callback) {
      this.listeners[name] = callback;
    }
    remove() {
      this.isConnected = false;
      this.parent.children = this.parent.children.filter(child => child !== this);
    }
  }
  global.document = {createElement: () => new Element()};
  global.addEventListener = () => {};
  const source = (await fs.readFile(path.resolve(__dirname, "../addon/data-load.js"), "utf8"))
    .replace('"./inspector.js"', JSON.stringify(inspectorUrl.href)) + "\nexport {renderCell};\n";
  const {renderCell} = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
  const table = {
    sfHost: "example.com",
    describeInfo: {describeGlobal: () => ({globalDescribe: {sobjects: [{keyPrefix: "005", name: "User"}]}})},
    getRecordLoginLinks: id => getRecordLoginLinks("example.com", id, userInfo)
  };
  const openMenu = rt => {
    const cell = new Element();
    renderCell(rt, userId, cell);
    cell.children[0].listeners.click({preventDefault() {}});
    return cell.children[1];
  };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await t.test("the four existing actions remain and the login action is appended", async () => {
    reset(activeUser);
    const menu = openMenu(table);
    assert.equal(menu.children.length, 4);
    await settle();
    assert.deepEqual(menu.children.map(child => child.textContent), ["Show all data", "Query Record", "View in Salesforce", "Copy Id", "Login As"]);
    assert.equal(menu.children[4].target, "_blank");
  });
  await t.test("a dismissed menu receives no delayed login links", async () => {
    reset(activeUser);
    const menu = openMenu(table);
    menu.remove();
    await settle();
    assert.equal(menu.children.length, 4);
  });
  await t.test("API permission failures preserve the four existing actions", async () => {
    reset(new Error("INSUFFICIENT_ACCESS"));
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const menu = openMenu(table);
      await settle();
      assert.equal(menu.children.length, 4);
    } finally {
      console.warn = originalWarn;
    }
  });
  await t.test("other shared table pages do not perform login lookups", async () => {
    reset();
    const {getRecordLoginLinks: unused, ...otherTable} = table;
    assert.ok(unused);
    const menu = openMenu(otherTable);
    await settle();
    assert.equal(menu.children.length, 4);
    assert.equal(calls.length, 0);
  });
});
