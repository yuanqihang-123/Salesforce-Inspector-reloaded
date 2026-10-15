/* global React */
/* eslint-disable react/prop-types */
import {querySummary, previewTokens} from "./query-history.js";
import {buildQuery, matchingObjects, readTemplates, renderCustom, saveTemplate, deleteTemplate, parametersIn, parameterTypes, quoteText, validateTemplate, TEMPLATE_KEY, TEMPLATE_USAGE_KEY} from "./query-templates.js";
import {QueryLibraryBrowser, queryLibraryRows, queryLibraryPosition} from "./query-library-browser.js";
const h = React.createElement;

export class QueryTemplatePanel extends React.Component {
  constructor(props) {
    super(props);
    this.state = {open: false, templates: [], search: "", selected: "ids", values: {}, editing: null, error: "", replace: false};
    this.outside = e => { if (this.state.open && !this.root.contains(e.target)) { this.close(); } };
    this.storage = e => { if (this.state.open && [TEMPLATE_KEY, TEMPLATE_USAGE_KEY, "queryTemplates", null].includes(e.key)) { this.refresh(); } };
    this.resize = () => { if (this.state.open) { this.forceUpdate(); } };
  }
  componentDidMount() {
    document.addEventListener("mousedown", this.outside);
    window.addEventListener("storage", this.storage);
    window.addEventListener("resize", this.resize);
  }
  componentWillUnmount() {
    document.removeEventListener("mousedown", this.outside);
    window.removeEventListener("storage", this.storage);
    window.removeEventListener("resize", this.resize);
  }
  refresh() {
    try { this.setState({templates: readTemplates(), error: ""}); } catch { this.setState({error: "Could not read saved templates. Local storage is unavailable or damaged."}); }
  }
  close() { this.setState({open: false, editing: null, replace: false}, () => this.trigger.focus()); }
  toggle() {
    if (this.state.open) { this.close(); return; }
    let {model} = this.props;
    let object = querySummary(model.queryInput.value).object;
    this.refresh();
    this.setState({open: true, search: "", selected: "ids", values: {object: object === "Query" ? "" : object, field: "", days: "7", ids: "", keyword: ""}, tooling: !!model.queryTooling, replace: false, editing: null, objectPicker: null}, () => { const first = this.rows()[0]; if (first) { this.choose(first); } this.search.focus(); });
  }
  libraryProps() {
    return {
      items: this.state.templates,
      search: this.state.search,
      selected: this.state.selected,
      itemKey: template => template.id,
      itemTexts: template => [template.name, template.description, template.query, template.kind],
      itemCount: template => template.runCount || 0,
      onSearchChange: (search, callback) => this.setState({search, replace: false}, callback),
      onSelect: (template, callback) => template ? this.choose(template, callback) : this.setState({selected: null}, callback),
      onRun: () => this.load(false, false, true),
      disabled: !!this.state.editing || this.state.replace,
      inputRef: el => { this.search = el; },
      searchLabel: "Search templates",
      placeholder: "Search templates",
      listLabel: "Query templates",
      listClassName: "template-list",
      optionClassName: "template-select",
      bodyClassName: "template-body",
      emptyMessage: "No matching templates",
      renderItem: template => h("span", {}, h("strong", {}, template.name), h("small", {}, template.description || (template.kind === "builtin" ? "SOQL · Built-in" : template.kind === "starter" ? "Query starter" : template.kind === "legacy" ? "Original snippet" : template.useToolingApi ? "Tooling API" : "Custom query")))
    };
  }
  rows() { return queryLibraryRows(this.libraryProps()); }
  selected() { return this.rows().find(t => t.id === this.state.selected); }
  choose(template, callback) {
    this.setState({selected: template.id, editing: null, replace: false, objectPicker: null, error: "", tooling: template.kind === "custom" ? !!template.useToolingApi : this.state.tooling, values: {...this.state.values, ...Object.fromEntries((template.parameters || []).map(p => [p.name, p.default || ""]))}}, callback);
  }
  metadata(object, tooling) {
    let {model} = this.props;
    let global = model.describeInfo.describeGlobal(tooling);
    let result = object ? model.describeInfo.describeSobject(tooling, object) : {sobjectDescribe: null, sobjectStatus: "empty"};
    return {objects: (global.globalDescribe?.sobjects || []).filter(o => o.queryable), ...result, globalStatus: global.globalStatus};
  }
  preview(template, metadata) {
    if (!template) { return {query: "", message: "Select a template"}; }
    try {
      let query = template.kind === "builtin" ? buildQuery(template.id, this.state.values, metadata.sobjectDescribe) : ["legacy", "starter"].includes(template.kind) ? template.query : renderCustom(template, this.state.values);
      if (template.kind === "custom") {
        for (let p of template.parameters) {
          let value = this.state.values[p.name];
          if (p.type === "object" && metadata.globalStatus !== "ready") { throw new Error("Wait for objects to load."); }
          if (p.type === "object" && !metadata.objects.some(o => o.name.toLowerCase() === value.toLowerCase())) { throw new Error(`Unknown queryable object: ${value}`); }
          if (p.type === "field" && !metadata.sobjectDescribe?.fields.some(f => f.name.toLowerCase() === value.toLowerCase())) { throw new Error(`Choose an available field on ${this.state.values.object || "the parameter object"}.`); }
        }
      }
      return {query, message: ""};
    } catch (error) { return {query: "", message: error.message}; }
  }
  change(name, value) {
    let objectChanged = name === "object" && (this.state.values.object || "").trim().toLowerCase() !== value.trim().toLowerCase();
    this.setState({values: {...this.state.values, [name]: value, ...(objectChanged ? {field: ""} : {})}, replace: false});
  }
  load(newTab, replace = false, run = false) {
    if (this.props.model.isWorking) { return; }
    let template = this.selected();
    let metadata = this.currentMetadata(template);
    let {query} = this.preview(template, metadata);
    if (!query) { return; }
    if (!newTab && !replace && this.props.model.hasQueryEdits()) { this.setState({replace: true, runAfterLoad: run}, () => this.cancel.focus()); return; }
    try {
      this.props.model.loadHistoryQuery({query, useToolingApi: this.state.tooling, templateId: template.id}, newTab);
      this.setState({open: false, replace: false});
      this.props.model.queryInput.focus();
    } catch { this.setState({error: "Could not save the query tab. Please try again."}); return; }
    if (run) {
      this.props.model.doExport();
      this.props.model.didUpdate();
    }
  }
  currentMetadata(template) {
    if (template?.kind !== "builtin" && !template?.parameters?.some(p => ["object", "field"].includes(p.type))) { return {objects: [], sobjectDescribe: null, sobjectStatus: "empty"}; }
    let objectParameter = template?.parameters?.find(p => p.type === "object");
    let object = objectParameter ? this.state.values[objectParameter.name] : template?.kind === "custom" ? querySummary(template.query).object : this.state.values.object;
    return this.metadata(object === "Query" ? "" : object || "", this.state.tooling);
  }
  create(template) {
    let query = template?.query ?? this.props.model.queryInput.value;
    this.setState({editing: {id: template?.kind === "custom" ? template.id : crypto.randomUUID(), name: template?.kind === "custom" ? template.name : "", query, parameters: template?.parameters || [], useToolingApi: template?.kind === "custom" ? template.useToolingApi : template ? this.state.tooling : !!this.props.model.queryTooling}, replace: false, error: ""}, () => this.nameInput.focus());
  }
  editQuery(query) {
    let editing = this.state.editing;
    let parameters = parametersIn(query).map(name => editing.parameters.find(p => p.name === name) || {name, type: "text", default: ""});
    this.setState({editing: {...editing, query, parameters}, error: ""});
  }
  makeParameter() {
    let input = this.queryEditor;
    let start = input.selectionStart;
    let end = input.selectionEnd;
    let {editing} = this.state;
    if (start === end) { this.setState({error: "Select a complete value or field in the query first."}); return; }
    if (editing.query[start - 1] === "'" && editing.query[end] === "'") { start--; end++; }
    let selected = editing.query.slice(start, end);
    if (selected.includes("{{")) { this.setState({error: "Select a value that is not already a parameter."}); return; }
    let n = 1;
    while (editing.parameters.some(p => p.name === `value${n}`)) { n++; }
    let name = `value${n}`;
    let type = /^'.*'$/s.test(selected) ? "text" : /^-?\d+(\.\d+)?$/.test(selected) ? "number" : /^\d{4}-\d{2}-\d{2}$/.test(selected) ? "date" : "field";
    let value = type === "text" ? selected.slice(1, -1).replace(/\\([\\'])/g, "$1") : selected;
    let query = editing.query.slice(0, start) + `{{${name}}}` + editing.query.slice(end);
    try {
      if (type === "text" && quoteText(value) !== selected) { value = ""; }
      validateTemplate({name: "Draft", query, parameters: [...editing.parameters, {name, type, default: value}]});
      this.setState({editing: {...editing, query, parameters: [...editing.parameters, {name, type, default: value}]}, error: ""}, () => input.focus());
    } catch (error) { this.setState({error: error.message}); }
  }
  save() {
    try {
      saveTemplate(this.state.editing);
      let template = {...this.state.editing, kind: "custom"};
      this.refresh();
      this.setState({search: ""});
      this.choose(template);
      this.setState({}, () => this.search?.focus());
    } catch (error) { this.setState({error: `Could not save template: ${error.message}`}); }
  }
  remove(template) {
    if (!window.confirm(`Delete template "${template.name}"?`)) { return; }
    try { deleteTemplate(template.id); this.refresh(); this.setState({selected: "ids", search: "", error: "", replace: false}); } catch { this.setState({error: "Could not delete template. Please try again."}); }
  }
  navigate(e) {
    if (e.key === "Enter" && this.state.open && !this.state.editing && !this.state.replace && !e.isComposing && !e.shiftKey
      && (e.target.closest(".template-parameters") || e.target === this.loadButton)) {
      e.preventDefault(); e.stopPropagation();
      if (!e.repeat) { this.load(false, false, true); }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation();
      if (this.state.replace) { this.setState({replace: false}, () => this.loadButton.focus()); } else if (this.state.editing) { this.setState({editing: null, error: ""}, () => this.search.focus()); } else { this.close(); }
    }
    if (this.state.replace && e.key === "Tab") {
      let buttons = [...this.root.querySelectorAll(".history-confirm button:not(:disabled)")];
      let index = buttons.indexOf(document.activeElement);
      e.preventDefault();
      buttons[(index + (e.shiftKey ? buttons.length - 1 : 1)) % buttons.length]?.focus();
    }
  }

  input(label, name, metadata, type = "text", options = null) {
    if (type === "object") { return this.objectInput(label, name, metadata); }
    let list = type === "field" ? "template-fields" : undefined;
    return h("label", {className: "template-parameter", key: name}, label,
      options ? h("select", {value: this.state.values[name] || "", onChange: e => this.change(name, e.target.value)}, h("option", {value: ""}, "Choose a field"), options.map(f => h("option", {key: f.name, value: f.name}, `${f.label || f.name} (${f.name})`)))
      : h(name === "ids" ? "textarea" : "input", {value: this.state.values[name] ?? "", type: type === "number" ? "number" : type === "date" ? "date" : "text", list, onChange: e => this.change(name, e.target.value)})
    );
  }
  objectInput(label, name, metadata) {
    let matches = matchingObjects(metadata.objects, this.state.values[name]);
    let open = this.state.objectPicker === name && matches.length > 0;
    let index = Math.min(this.state.objectIndex || 0, matches.length - 1);
    let select = (object, callback) => {
      this.change(name, object.name);
      this.setState({objectPicker: null, objectIndex: 0}, callback);
    };
    let id = `template-object-${name}`;
    return h("div", {className: "template-parameter template-object-picker", key: name},
      h("label", {htmlFor: id}, label),
      h("input", {id,
        role: "combobox",
        "aria-autocomplete": "list",
        "aria-expanded": !!open,
        "aria-controls": `${id}-options`,
        "aria-activedescendant": open ? `${id}-option-${index}` : undefined,
        value: this.state.values[name] || "",
        autoComplete: "off",
        onFocus: () => this.setState({objectPicker: name, objectIndex: 0}),
        onBlur: () => this.setState({objectPicker: null}),
        onChange: e => { this.change(name, e.target.value); this.setState({objectPicker: name, objectIndex: 0}); },
        onKeyDown: e => {
          if (e.isComposing) { return; }
          if (["ArrowDown", "ArrowUp"].includes(e.key)) {
            e.preventDefault(); e.stopPropagation();
            this.setState({objectPicker: name, objectIndex: open ? Math.max(0, Math.min(matches.length - 1, index + (e.key === "ArrowDown" ? 1 : -1))) : 0}, () => document.getElementById(`${id}-option-${this.state.objectIndex}`)?.scrollIntoView({block: "nearest"}));
          } else if (open && e.key === "Escape") {
            e.preventDefault(); e.stopPropagation(); this.setState({objectPicker: null});
          } else if (open && e.key === "Enter" && !e.repeat) {
            let exact = matches[index].name.toLowerCase() === (this.state.values[name] || "").trim().toLowerCase();
            e.preventDefault(); e.stopPropagation();
            select(matches[index], exact && !e.shiftKey ? () => this.load(false, false, true) : undefined);
          }
        }
      }),
      open && h("div", {id: `${id}-options`, role: "listbox", className: "template-object-options"}, matches.map((o, i) =>
        h("div", {id: `${id}-option-${i}`, key: o.name, role: "option", "aria-selected": i === index, className: i === index ? "selected" : "", onMouseDown: e => { e.preventDefault(); select(o); }},
          h("strong", {}, o.name), o.label && o.label !== o.name && h("small", {}, o.label))
      ))
    );
  }
  renderEditor() {
    let {editing} = this.state;
    let update = patch => this.setState({editing: {...editing, ...patch}, error: ""});
    return h("div", {className: "template-editor"},
      h("label", {}, "Template name", h("input", {ref: el => { this.nameInput = el; }, value: editing.name, onChange: e => update({name: e.target.value})})),
      h("label", {}, "Query pattern", h("textarea", {ref: el => { this.queryEditor = el; }, "aria-label": "Query pattern", value: editing.query, onChange: e => this.editQuery(e.target.value), rows: 8})),
      h("button", {onClick: () => this.makeParameter()}, "Make selection a parameter"),
      h("p", {}, "Select a complete value (including quotes) or use {{name}}. Text parameters add quotes automatically. Date parameters use YYYY-MM-DD. Field parameters use the first object parameter or the query's FROM object."),
      editing.parameters.map((p, i) => h("div", {key: p.name, className: "template-definition"},
        h("label", {}, p.name, h("select", {value: p.type, onChange: e => update({parameters: editing.parameters.map((item, j) => j === i ? {...item, type: e.target.value} : item)})}, parameterTypes.map(type => h("option", {key: type}, type)))),
        h("label", {}, "Default value", h("input", {value: p.default || "", onChange: e => update({parameters: editing.parameters.map((item, j) => j === i ? {...item, default: e.target.value} : item)})}))
      )),
      h("label", {}, h("input", {type: "checkbox", checked: !!editing.useToolingApi, onChange: e => update({useToolingApi: e.target.checked})}), " Tooling API"),
      h("div", {className: "history-actions"}, h("button", {onClick: () => this.save()}, "Save template"), h("button", {onClick: () => this.setState({editing: null, error: ""}, () => this.search.focus())}, "Cancel"))
    );
  }
  render() {
    let {open, editing, values, replace, error} = this.state;
    let template = this.selected();
    let metadata = open ? this.currentMetadata(template) : {objects: []};
    let preview = open ? this.preview(template, metadata) : {query: ""};
    let fields = metadata.sobjectDescribe?.fields || [];
    let rect = this.trigger?.getBoundingClientRect();
    return h("div", {className: "history-container", ref: el => { this.root = el; }, onKeyDown: e => this.navigate(e)},
      h("button", {className: "query-library-button", ref: el => { this.trigger = el; }, "aria-expanded": open, "aria-controls": "query-template-panel", onClick: () => this.toggle()},
        h("svg", {viewBox: "0 0 24 24", "aria-hidden": "true"}, h("path", {d: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"})),
        "Templates"
      ),
      open && h("section", {id: "query-template-panel", className: "history-panel template-panel", "aria-label": "Query templates", style: queryLibraryPosition(rect, window, 0.8)},
        h("datalist", {id: "template-fields"}, fields.map(f => h("option", {key: f.name, value: f.name}, f.label))),
        h(QueryLibraryBrowser, {...this.libraryProps(),
          editor: editing ? this.renderEditor() : null,
          toolbar: h("div", {className: "query-library-toolbar-actions"},
            h("button", {onClick: () => this.create()}, "From current query"),
            h("button", {"aria-label": "Close templates", onClick: () => this.close()}, "×")
          )},
        h("div", {className: "history-preview template-preview"},
          h("div", {className: "template-parameters"},
            template?.kind === "builtin" && this.input("Object", "object", metadata, "object"),
            template?.kind === "builtin" && ["search", "group", "duplicates"].includes(template.id) && this.input("Field", "field", metadata, "field", fields.filter(f => template.id === "search" ? f.filterable && ["string", "textarea", "email", "phone", "url"].includes(f.type) : f.groupable && (template.id !== "duplicates" || f.filterable))),
            template?.id === "ids" && this.input("Record IDs", "ids", metadata),
            ["created", "modified"].includes(template?.id) && this.input("Last N days (includes today)", "days", metadata, "number"),
            template?.id === "search" && this.input("Keyword", "keyword", metadata),
            template?.kind === "custom" && template.parameters.map(p => this.input(p.name, p.name, metadata, p.type)),
            ["legacy", "starter"].includes(template?.kind) && h("p", {}, "Query snippet: edit it after loading, or convert it to a parameterized template."),
            template?.kind !== "custom" && h("label", {}, h("input", {type: "checkbox", checked: !!this.state.tooling, onChange: e => this.setState({tooling: e.target.checked, values: {...values, field: ""}, replace: false})}), " Tooling API"),
            ["loadfailed", "notfound"].includes(metadata.sobjectStatus) && h("p", {role: "status"}, metadata.sobjectStatus === "notfound" ? "Object not found in this API." : "Could not load object metadata. Reopen Data Export to retry."),
            preview.message && h("p", {role: "status"}, preview.message)
          ),
          h("pre", {tabIndex: 0, "aria-label": "Generated query preview"}, previewTokens(preview.query).map((token, i) => h("span", {key: i, className: token.kind ? `history-${token.kind}` : ""}, token.text))),
          h("div", {className: "history-actions"},
            h("button", {ref: el => { this.loadButton = el; }, disabled: !preview.query || this.props.model.isWorking, onClick: () => this.load(false)}, "Load query"),
            h("button", {disabled: !preview.query || this.props.model.isWorking, onClick: () => this.load(true)}, "Open in new tab"),
            template && template.kind !== "builtin" && h("button", {onClick: () => this.create(template)}, template.kind === "custom" ? "Edit template" : "Convert to template"),
            template?.kind === "custom" && h("button", {onClick: () => this.remove(template)}, "Delete template"),
            this.props.model.isWorking && h("small", {}, "Wait for the current export to finish")
          )
        )
        ),
        replace && h("div", {className: "history-confirm", role: "dialog", "aria-label": "Replace the current query?"}, h("p", {}, "Replace the current query? Your edits will be overwritten."),
          h("button", {ref: el => { this.cancel = el; }, onClick: () => this.setState({replace: false}, () => this.loadButton.focus())}, "Cancel"),
          h("button", {disabled: this.props.model.isWorking, onClick: () => this.load(true, false, this.state.runAfterLoad)}, "Open in new tab"),
          h("button", {disabled: this.props.model.isWorking, onClick: () => this.load(false, true, this.state.runAfterLoad)}, "Replace")
        ),
        error && h("p", {className: "template-error", role: "alert"}, error)
      )
    );
  }
}
