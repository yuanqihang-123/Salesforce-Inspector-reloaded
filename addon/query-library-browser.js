/* global React */
/* eslint-disable react/prop-types */
import {englishSearch, rankQueryOptions} from "./query-history.js";
const h = React.createElement;

export function queryLibraryRows({items, search, itemTexts, itemCount, prioritizeMatches}) {
  return rankQueryOptions(items, search, itemTexts, itemCount, prioritizeMatches);
}

// Open toward the right of the trigger and keep the panel inside the viewport.
export function queryLibraryPosition(rect, viewport, heightRatio = 0.7) {
  const width = Math.min(960, viewport.innerWidth - 32);
  const top = rect ? Math.min(rect.bottom + 6, Math.max(16, viewport.innerHeight - 250)) : 60;
  return {
    left: Math.max(16, Math.min(viewport.innerWidth - width - 16, rect?.left ?? 16)),
    top,
    maxHeight: Math.min(viewport.innerHeight * heightRatio, viewport.innerHeight - top - 16)
  };
}

// Both query libraries use this component for search, selection and list navigation.
export class QueryLibraryBrowser extends React.Component {
  rows() { return queryLibraryRows(this.props); }
  changeSearch(value) {
    this.props.onSearchChange(englishSearch(value), () => {
      this.props.onSelect(this.rows()[0] || null, () => {
        if (this.list) { this.list.scrollTop = 0; }
      });
    });
  }
  navigate(e) {
    if (this.props.disabled || e.isComposing || e.nativeEvent?.isComposing) { return; }
    const fromSearch = e.target === this.search;
    if (!fromSearch && !e.target.dataset?.queryLibraryRow) { return; }
    if (e.key === "Delete" && this.props.onDelete && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      const selected = this.rows().find(item => this.props.itemKey(item) === this.props.selected);
      if (!selected) { return; }
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) { this.props.onDelete(selected); }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat && this.rows().some(item => this.props.itemKey(item) === this.props.selected)) { this.props.onRun(); }
      return;
    }
    if (!["ArrowDown", "ArrowUp"].includes(e.key)) { return; }
    e.preventDefault();
    e.stopPropagation();
    const rows = this.rows();
    const index = rows.findIndex(item => this.props.itemKey(item) === this.props.selected);
    const next = rows[Math.max(0, Math.min(rows.length - 1, index + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next) {
      this.props.onSelect(next, () => {
        const row = this.list?.querySelector('[data-selected="true"]');
        row?.scrollIntoView({block: "nearest"});
        if (!fromSearch) { row?.focus(); }
      });
    }
  }
  render() {
    const {search, selected, itemKey, itemCount, renderItem, itemTitle, renderActions, searchLabel, placeholder,
      inputRef, toolbar, listLabel, listClassName = "", optionClassName = "", bodyClassName = "", emptyMessage, editor, children} = this.props;
    const rows = this.rows();
    return h("div", {className: "query-library-browser"},
      h("div", {className: "history-toolbar"},
        h("input", {type: "search",
          ref: el => { this.search = el; inputRef?.(el); },
          "aria-label": searchLabel,
          placeholder,
          value: search,
          disabled: !!editor,
          autoComplete: "off",
          lang: "en",
          onChange: e => this.changeSearch(e.target.value),
          onKeyDown: e => this.navigate(e)}),
        toolbar
      ),
      editor || h("div", {className: `history-body ${bodyClassName}`.trim()},
        h("div", {className: `history-list ${listClassName}`.trim(), "aria-label": listLabel, ref: el => { this.list = el; }, onKeyDown: e => this.navigate(e)},
          !rows.length && h("p", {}, emptyMessage),
          !rows.length && search && h("button", {onClick: () => this.changeSearch("")}, "Clear search"),
          rows.map(item => {
            const key = itemKey(item);
            const active = selected === key;
            const count = itemCount(item);
            return h("div", {key, className: "history-row" + (active ? " selected" : "")},
              h("button", {className: `history-select ${optionClassName}`.trim(),
                "data-query-library-row": "true",
                "data-selected": active,
                "aria-pressed": active,
                title: itemTitle?.(item),
                onFocus: () => { if (!active) { this.props.onSelect(item); } },
                onClick: () => this.props.onSelect(item)},
              h("span", {className: "query-run-count", title: `${count} successful runs`, "aria-label": `${count} runs`}, count),
              h("span", {className: "query-option-text"}, renderItem(item))),
              renderActions?.(item)
            );
          })
        ),
        children
      )
    );
  }
}
