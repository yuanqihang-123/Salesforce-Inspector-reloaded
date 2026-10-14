/* global React */
/* eslint-disable react/prop-types */
import {querySummary, previewTokens} from "./query-history.js";
import {buildQuery, readTemplates, renderCustom, saveTemplate, deleteTemplate, parametersIn, parameterTypes, quoteText, validateTemplate, TEMPLATE_KEY} from "./query-templates.js";
const h = React.createElement;

export class QueryTemplatePanel extends React.Component {
  constructor(props) {
    super(props);
    this.state = {open: false, templates: [], search: "", selected: "ids", values: {}, editing: null, error: "", replace: false};
    this.outside = e => { if (this.state.open && !this.root.contains(e.target)) { this.close(); } };
    this.storage = e => { if (this.state.open && [TEMPLATE_KEY, "queryTemplates", null].includes(e.key)) { this.refresh(); } };
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
    this.setState({open: true, search: "", selected: "ids", values: {object: object === "Query" ? "" : object, field: "", days: "7", limit: "200", ids: "", keyword: ""}, tooling: !!model.queryTooling, replace: false, editing: null}, () => this.search.focus());
  }
  rows() {
    let words = this.state.search.toLowerCase().trim().split(/\s+/);
    return this.state.templates.filter(t => words.every(w => `${t.name} ${t.description || ""} ${t.query || ""} ${t.kind}`.toLowerCase().includes(w)));
  }
  selected() { return this.rows().find(t => t.id === this.state.selected); }
  choose(template) {
    this.setState({selected: template.id, editing: null, replace: false, error: "", tooling: template.kind === "custom" ? !!template.useToolingApi : this.state.tooling, values: {...this.state.values, ...Object.fromEntries((template.parameters || []).map(p => [p.name, p.default || ""]))}});
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
    this.setState({values: {...this.state.values, [name]: value, ...(name === "object" ? {field: ""} : {})}, replace: false});
  }
  load(newTab, replace = false) {
    if (this.props.model.isWorking) { return; }
    let template = this.selected();
    let metadata = this.currentMetadata(template);
    let {query} = this.preview(template, metadata);
    if (!query) { return; }
    if (!newTab && !replace && this.props.model.hasQueryEdits()) { this.setState({replace: true}, () => this.cancel.focus()); return; }
    try {
      this.props.model.loadHistoryQuery({query, useToolingApi: this.state.tooling}, newTab);
      this.setState({open: false, replace: false});
      this.props.model.queryInput.focus();
    } catch { this.setState({error: "Could not save the query tab. Please try again."}); }
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
    if (!this.state.editing && !this.state.replace && ["ArrowUp", "ArrowDown"].includes(e.key) && (e.target === this.search || e.target.dataset.templateRow)) {
      e.preventDefault();
      let rows = this.rows();
      let index = rows.findIndex(t => t.id === this.state.selected);
      let next = rows[Math.max(0, Math.min(rows.length - 1, index + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) { this.choose(next); this.setState({}, () => { let row = [...this.root.querySelectorAll("[data-template-row]")].find(el => el.dataset.templateRow === next.id); row?.scrollIntoView({block: "nearest"}); if (e.target !== this.search) { row?.focus(); } }); }
    }
  }
  input(label, name, metadata, type = "text", options = null) {
    let list = type === "object" ? "template-objects" : type === "field" ? "template-fields" : undefined;
    return h("label", {className: "template-parameter", key: name}, label,
      options ? h("select", {value: this.state.values[name] || "", onChange: e => this.change(name, e.target.value)}, h("option", {value: ""}, "Choose a field"), options.map(f => h("option", {key: f.name, value: f.name}, `${f.label || f.name} (${f.name})`)))
      : h(name === "ids" ? "textarea" : "input", {value: this.state.values[name] ?? "", type: type === "number" ? "number" : type === "date" ? "date" : "text", list, onChange: e => this.change(name, e.target.value)})
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
    let rows = this.rows();
    let rect = this.trigger?.getBoundingClientRect();
    let width = Math.min(960, window.innerWidth - 32);
    let top = rect ? Math.min(rect.bottom + 6, Math.max(16, window.innerHeight - 250)) : 60;
    return h("div", {className: "history-container", ref: el => { this.root = el; }, onKeyDown: e => this.navigate(e)},
      h("button", {ref: el => { this.trigger = el; }, "aria-expanded": open, "aria-controls": "query-template-panel", onClick: () => this.toggle()}, "Templates"),
      open && h("section", {id: "query-template-panel", className: "history-panel template-panel", "aria-label": "Query templates", style: {left: Math.max(16, Math.min(window.innerWidth - width - 16, rect?.left || 16)), top, maxHeight: Math.min(window.innerHeight * 0.8, window.innerHeight - top - 16)}},
        h("div", {className: "history-toolbar"},
          h("input", {type: "search", ref: el => { this.search = el; }, "aria-label": "Search templates", placeholder: "Search templates", value: this.state.search, disabled: !!editing, onChange: e => this.setState({search: e.target.value, replace: false}, () => { if (!this.selected() && this.rows()[0]) { this.choose(this.rows()[0]); } })}),
          h("button", {onClick: () => this.create()}, "From current query"),
          h("button", {"aria-label": "Close templates", onClick: () => this.close()}, "×")
        ),
        h("datalist", {id: "template-objects"}, metadata.objects.map(o => h("option", {key: o.name, value: o.name}, o.label))),
        h("datalist", {id: "template-fields"}, fields.map(f => h("option", {key: f.name, value: f.name}, f.label))),
        editing ? this.renderEditor() : h("div", {className: "history-body template-body"},
          h("div", {className: "history-list template-list"},
            !rows.length && h("p", {}, "No matching templates"),
            ["builtin", "starter", "custom", "legacy"].map(kind => h("div", {key: kind},
              rows.some(t => t.kind === kind) && h("h3", {}, {builtin: "SOQL · Built-in", starter: "SOSL / GraphQL", custom: "My templates", legacy: "Legacy snippets"}[kind]),
              rows.filter(t => t.kind === kind).map(t => h("div", {key: t.id, className: "history-row" + (this.state.selected === t.id ? " selected" : "")},
                h("button", {className: "history-select template-select", "data-template-row": t.id, "aria-pressed": this.state.selected === t.id, onClick: () => this.choose(t)}, h("strong", {}, t.name), h("small", {}, t.description || (t.kind === "starter" ? "Query starter" : t.kind === "legacy" ? "Original snippet" : t.useToolingApi ? "Tooling API" : "Custom query")))
              ))
            ))
          ),
          h("div", {className: "history-preview template-preview"},
            h("div", {className: "template-parameters"},
              template?.kind === "builtin" && this.input("Object", "object", metadata, "object"),
              template?.kind === "builtin" && ["search", "group", "duplicates"].includes(template.id) && this.input("Field", "field", metadata, "field", fields.filter(f => template.id === "search" ? f.filterable && ["string", "textarea", "email", "phone", "url"].includes(f.type) : f.groupable && (template.id !== "duplicates" || f.filterable))),
              template?.id === "ids" && this.input("Record IDs", "ids", metadata),
              ["created", "modified"].includes(template?.id) && this.input("Last N days (includes today)", "days", metadata, "number"),
              template?.id === "search" && this.input("Keyword", "keyword", metadata),
              template?.kind === "builtin" && this.input("Record limit (1–2000)", "limit", metadata, "number"),
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
          h("button", {disabled: this.props.model.isWorking, onClick: () => this.load(true)}, "Open in new tab"),
          h("button", {disabled: this.props.model.isWorking, onClick: () => this.load(false, true)}, "Replace")
        ),
        error && h("p", {className: "template-error", role: "alert"}, error)
      )
    );
  }
}
