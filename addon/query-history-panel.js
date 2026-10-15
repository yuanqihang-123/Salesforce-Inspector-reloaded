/* global React */
/* eslint-disable react/prop-types */
import {historyKey, querySummary, previewTokens, executionCount} from "./query-history.js";
import {QueryLibraryBrowser, queryLibraryRows, queryLibraryPosition} from "./query-library-browser.js";
const h = React.createElement;

function executionTime(entry) {
  if (!Number.isFinite(entry.lastExecutedAt)) { return {label: "Time unavailable", title: "Time unavailable"}; }
  let seconds = Math.max(0, Math.floor((Date.now() - entry.lastExecutedAt) / 1000));
  let label = seconds < 60 ? "Just now" : seconds < 3600 ? `${Math.floor(seconds / 60)} min ago` : seconds < 86400 ? `${Math.floor(seconds / 3600)} hour${seconds < 7200 ? "" : "s"} ago` : `${Math.floor(seconds / 86400)} day${seconds < 172800 ? "" : "s"} ago`;
  return {label, title: new Date(entry.lastExecutedAt).toLocaleString()};
}

export class QueryHistoryPanel extends React.Component {
  constructor(props) {
    super(props);
    this.state = {open: false, search: "", selected: null, more: false, replace: false, error: ""};
    this.root = {current: null};
    this.trigger = {current: null};
    this.search = {current: null};
    this.onOutside = e => {
      if (this.state.open && !this.root.current.contains(e.target)) { this.close(); }
    };
    this.onResize = () => { if (this.state.open) { this.forceUpdate(); } };
    this.onStorage = e => {
      if (e.key === this.props.model.queryHistory.storageKey) { this.refresh(); }
    };
  }
  componentDidMount() {
    document.addEventListener("mousedown", this.onOutside);
    window.addEventListener("storage", this.onStorage);
    window.addEventListener("resize", this.onResize);
    this.timeTimer = setInterval(() => { if (this.state.open) { this.forceUpdate(); } }, 60000);
  }
  componentWillUnmount() {
    document.removeEventListener("mousedown", this.onOutside);
    window.removeEventListener("storage", this.onStorage);
    window.removeEventListener("resize", this.onResize);
    clearInterval(this.timeTimer);
  }
  componentDidUpdate() {
    if (this.state.open && !this.selected() && this.rows().length) {
      this.setState({selected: historyKey(this.rows()[0]), replace: false});
    }
  }
  libraryProps() {
    return {
      items: this.props.model.queryHistory.list,
      search: this.state.search,
      selected: this.state.selected,
      itemKey: historyKey,
      itemTexts: entry => [querySummary(entry.query).object, entry.query],
      itemCount: executionCount,
      onSearchChange: (search, callback) => this.setState({search, replace: false}, callback),
      onSelect: (entry, callback) => this.setState({selected: entry ? historyKey(entry) : null, replace: false}, callback),
      onRun: () => this.load(false, true, true),
      disabled: this.state.replace || this.state.more,
      inputRef: el => { this.search.current = el; },
      searchLabel: "Search query history",
      placeholder: "Search objects, fields or query text",
      listLabel: "Historical queries",
      emptyMessage: this.props.model.queryHistory.list.length ? "No matching queries" : "No query history yet",
      itemTitle: entry => `${executionTime(entry).title} · ${entry.useToolingApi ? "Tooling API" : "Data API"}`,
      renderItem: entry => {
        const summary = querySummary(entry.query);
        return h("span", {},
          h("span", {className: "history-summary history-fields"}, summary.fields),
          h("strong", {className: "history-summary history-object"}, summary.object),
          summary.clauses && h("span", {className: "history-summary history-clauses"}, summary.clauses));
      },
      renderActions: entry => h("button", {className: "history-delete", "aria-label": `Delete query: ${entry.query}`, title: "Delete query", onClick: () => this.delete(entry)}, "×")
    };
  }
  rows() { return queryLibraryRows(this.libraryProps()); }
  selected() { return this.rows().find(e => historyKey(e) === this.state.selected); }
  refresh() {
    this.props.model.queryHistory.refresh();
    this.reconcile();
  }
  reconcile(preferred = this.state.selected) {
    let rows = this.rows();
    this.setState({selected: rows.some(e => historyKey(e) === preferred) ? preferred : rows[0] ? historyKey(rows[0]) : null});
    this.props.model.didUpdate();
  }
  close() {
    this.setState({open: false, more: false, replace: false}, () => this.trigger.current?.focus());
  }
  toggle() {
    if (this.state.open) { this.close(); return; }
    this.props.model.queryHistory.refresh();
    let first = queryLibraryRows({...this.libraryProps(), search: ""})[0];
    this.setState({open: true, search: "", selected: first ? historyKey(first) : null, error: ""}, () => this.search.current?.focus());
  }
  navigate(e) {
    if (this.state.replace && e.key === "Tab") {
      let buttons = [...this.root.current.querySelectorAll(".history-confirm button:not(:disabled)")];
      let index = buttons.indexOf(document.activeElement);
      e.preventDefault();
      buttons[(index + (e.shiftKey ? buttons.length - 1 : 1)) % buttons.length]?.focus();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (this.state.replace) { this.setState({replace: false}, () => this.loadButton?.focus()); } else if (this.state.more) { this.setState({more: false}, () => this.moreButton?.focus()); } else { this.close(); }
    }
  }

  load(newTab, replace = false, run = false) {
    let entry = this.selected();
    let {model} = this.props;
    if (!entry || model.isWorking) { return; }
    if (!newTab && !replace && model.hasQueryEdits()) {
      this.setState({replace: true}, () => this.cancelButton?.focus());
      return;
    }
    try {
      model.loadHistoryQuery(entry, newTab);
      this.setState({open: false, replace: false, more: false});
      model.queryInput.focus();
      if (run) { model.doExport(); model.didUpdate(); }
    } catch {
      this.setState({error: "Could not save the query tab. Please try again."});
    }
  }
  delete(entry) {
    let rows = this.rows();
    let index = rows.findIndex(q => historyKey(q) === historyKey(entry));
    let next = rows[index + 1] || rows[index - 1];
    try {
      let removed = this.props.model.queryHistory.remove(entry);
      if (!removed) { this.refresh(); return; }
      this.setState({error: "", replace: false}, () => {
        this.reconcile(this.state.selected === historyKey(entry) ? next ? historyKey(next) : null : this.state.selected);
        let row = this.root.current?.querySelector('[data-selected="true"]');
        (row || this.search.current)?.focus();
      });
    } catch {
      this.setState({error: "Could not delete the query. Local storage is unavailable."});
    }
  }
  clear() {
    if (!window.confirm("Clear all query history, including queries hidden by the search? This cannot be undone.")) { return; }
    try {
      this.props.model.queryHistory.clear();
      this.setState({selected: null, more: false, replace: false, error: ""});
      this.props.model.didUpdate();
      this.search.current?.focus();
    } catch {
      this.setState({error: "Could not clear query history. Please try again."});
    }
  }
  render() {
    let {model} = this.props;
    let {open, more, replace, error} = this.state;
    error = error || model.historyError;
    let rows = this.rows();
    let entry = this.selected();
    let rect = this.trigger.current?.getBoundingClientRect();
    let position = queryLibraryPosition(rect, window);
    return h("div", {className: "history-container", ref: el => { this.root.current = el; }, onKeyDown: e => this.navigate(e)},
      h("button", {className: "query-library-button", ref: el => { this.trigger.current = el; }, "aria-expanded": open, "aria-controls": "query-history-panel", onClick: () => this.toggle()},
        h("svg", {viewBox: "0 0 24 24", "aria-hidden": "true"}, h("path", {d: "M3 11a9 9 0 1 1 2.6 7.4M3 5v6h6M12 7v5l3 2"})),
        "History",
        h("span", {className: "query-history-count"}, model.queryHistory.list.length)
      ),
      open && h("section", {id: "query-history-panel", className: "history-panel", style: position, "aria-label": "Query history"},
        h(QueryLibraryBrowser, {...this.libraryProps(),
          toolbar: h("div", {className: "query-library-toolbar-actions"},
            h("span", {role: "status"}, `${rows.length} / ${model.queryHistory.list.length} queries`),
            h("button", {ref: el => { this.moreButton = el; }, "aria-expanded": more, onClick: () => this.setState({more: !more})}, "More"),
            h("button", {"aria-label": "Close query history", onClick: () => this.close()}, "×"),
            more && h("div", {className: "history-more"}, h("button", {disabled: !model.queryHistory.list.length, onClick: () => this.clear()}, "Clear all history"))
          )},
        h("div", {className: "history-preview", "aria-label": "Full query preview"},
          h("pre", {tabIndex: 0}, entry ? previewTokens(entry.query).map((token, i) => h("span", {key: i, className: token.kind ? `history-${token.kind}` : ""}, token.text)) : "Select a query to preview"),
          h("div", {className: "history-actions"},
            h("button", {ref: el => { this.loadButton = el; }, disabled: !entry || model.isWorking, onClick: () => this.load(false)}, "Load query"),
            h("button", {disabled: !entry || model.isWorking, onClick: () => this.load(true)}, "Open in new tab"),
            model.isWorking && h("small", {}, "Wait for the current export to finish")
          )
        )
        ),
        replace && h("div", {className: "history-confirm", role: "dialog", "aria-label": "Replace the current query?"},
          h("p", {}, "Replace the current query? Your edits will be overwritten."),
          h("button", {ref: el => { this.cancelButton = el; }, onClick: () => this.setState({replace: false}, () => this.loadButton?.focus())}, "Cancel"),
          h("button", {disabled: model.isWorking, onClick: () => this.load(true)}, "Open in new tab"),
          h("button", {disabled: model.isWorking, onClick: () => this.load(false, true)}, "Replace")
        )
      ),
      error && h("div", {className: "history-notice"},
        h("span", {role: "alert"}, error)
      )
    );
  }
}
