/* eslint-env node */
/* eslint-disable strict -- CommonJS tests use file-level strict mode. */
"use strict";
const assert = require("node:assert/strict");
const {test} = require("node:test");
global.React = require("../addon/react.js");

function nodes(tree) {
  if (Array.isArray(tree)) { return tree.flatMap(nodes); }
  if (!tree || typeof tree !== "object") { return []; }
  return [tree, ...nodes(tree.props.children)];
}

test("shared query library interactions", async t => {
  const {QueryLibraryBrowser} = await import("../addon/query-library-browser.js");
  function browser() {
    let runs = 0;
    let focused = 0;
    let scrolled = 0;
    const props = {
      items: [{id: "a", name: "User", count: 2}, {id: "b", name: "User", count: 5}, {id: "c", name: "UserLogin", count: 20}],
      search: "",
      selected: "c",
      itemKey: item => item.id,
      itemTexts: item => [item.name],
      itemCount: item => item.count,
      renderItem: item => item.name,
      onRun: () => { runs++; },
      onSearchChange(search, callback) { props.search = search; callback(); },
      onSelect(item, callback) { props.selected = item?.id ?? null; callback?.(); }
    };
    const component = new QueryLibraryBrowser(props);
    component.search = {};
    const row = {dataset: {queryLibraryRow: "true"}, focus() { focused++; }, scrollIntoView() { scrolled++; }};
    component.list = {scrollTop: 600, querySelector: () => row};
    const key = (key, target = component.search, flags = {}) => component.navigate({key, target, preventDefault() {}, stopPropagation() {}, ...flags});
    return {component, props, row, key, runs: () => runs, focused: () => focused, scrolled: () => scrolled};
  }
  await t.test("typing, pasting and clearing always reset scroll without focusing an option", () => {
    const {component, props, focused} = browser();
    component.changeSearch("中文User");
    assert.equal(props.search, "User");
    assert.equal(props.selected, "c");
    assert.equal(component.list.scrollTop, 0);
    component.list.scrollTop = 200;
    component.changeSearch("UserLogin");
    assert.equal(props.selected, "c");
    assert.equal(component.list.scrollTop, 0);
    component.changeSearch("missing");
    assert.equal(props.selected, null);
    const clear = nodes(component.render()).find(node => node.type === "button" && node.props.children === "Clear search");
    clear.props.onClick();
    assert.equal(props.search, "");
    assert.equal(props.selected, "c");
    assert.equal(focused(), 0);
  });
  await t.test("arrows from search keep input focus and clamp to list boundaries", () => {
    const {props, key, focused, scrolled} = browser();
    key("ArrowUp");
    assert.equal(props.selected, "c");
    key("ArrowDown");
    assert.equal(props.selected, "b");
    key("ArrowDown");
    key("ArrowDown");
    assert.equal(props.selected, "a");
    assert.equal(focused(), 0);
    assert.equal(scrolled(), 4);
  });
  await t.test("arrows from an option move focus, while Enter runs once", () => {
    const {props, key, row, runs, focused} = browser();
    key("ArrowDown", row);
    assert.equal(props.selected, "b");
    assert.equal(focused(), 1);
    key("Enter", row);
    key("Enter", row, {repeat: true});
    assert.equal(runs(), 1);
  });
  await t.test("composition, modal states, unrelated buttons and empty results cannot run", () => {
    const {component, props, key, row, runs} = browser();
    key("Enter", row, {isComposing: true});
    key("Enter", row, {nativeEvent: {isComposing: true}});
    key("Enter", row, {shiftKey: true});
    key("Enter", {dataset: {}});
    props.disabled = true;
    key("ArrowDown");
    key("Enter");
    assert.equal(props.selected, "c");
    props.disabled = false;
    component.changeSearch("missing");
    key("Enter");
    assert.equal(runs(), 0);
  });
  await t.test("mouse, arrows and option focus share selection for Delete", () => {
    const {component, props, row, key} = browser();
    const deleted = [];
    props.onDelete = item => deleted.push(item.id);
    const option = nodes(component.render()).filter(node => node.props["data-query-library-row"])[1];
    option.props.onClick();
    key("Delete", row);
    key("ArrowDown");
    key("Delete");
    option.props.onFocus();
    key("Delete", row);
    assert.deepEqual(deleted, ["b", "a", "b"]);
  });
  await t.test("Delete respects composition, modifiers, repeats and disabled states", () => {
    const {component, props, row} = browser();
    const deleted = [];
    props.onDelete = item => deleted.push(item.id);
    let prevented = 0;
    let stopped = 0;
    const event = {key: "Delete", target: row, preventDefault() { prevented++; }, stopPropagation() { stopped++; }};
    component.navigate(event);
    assert.deepEqual(deleted, ["c"]);
    assert.equal(props.selected, "c");
    component.navigate({...event, repeat: true});
    assert.equal(prevented, 2);
    assert.equal(stopped, 2);
    for (const flags of [{isComposing: true}, {nativeEvent: {isComposing: true}}, {ctrlKey: true}, {altKey: true}, {metaKey: true}, {shiftKey: true}, {key: "Backspace"}]) {
      component.navigate({...event, ...flags});
    }
    props.disabled = true;
    component.navigate(event);
    props.disabled = false;
    component.navigate({...event, target: {dataset: {}}});
    props.selected = null;
    component.navigate(event);
    assert.deepEqual(deleted, ["c"]);
    assert.equal(prevented, 2);
    delete props.onDelete;
    props.selected = "c";
    component.navigate(event);
    assert.equal(prevented, 2);
  });
  await t.test("editor mode disables search and replaces the option list", () => {
    const {component, props} = browser();
    props.editor = global.React.createElement("div", {className: "template-editor"}, "Editor");
    const tree = nodes(component.render());
    assert.equal(tree.find(node => node.type === "input").props.disabled, true);
    assert.equal(tree.some(node => node.props.className === "history-list"), false);
  });
});
