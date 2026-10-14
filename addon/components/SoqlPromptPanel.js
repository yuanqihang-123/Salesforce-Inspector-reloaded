/* global React */
/* eslint-disable react/prop-types */
import {getParentRelationships, LONG_PROMPT_THRESHOLD} from "../soql-prompt.js";

const h = React.createElement;

function matchesSearch(field, search) {
  return `${field.label} ${field.name}`.toLowerCase().includes(search.toLowerCase());
}

export function DataExportSoqlPromptPanel({model}) {
  return h(SoqlPromptPanel, {
    key: model.activeTabIndex,
    assistant: model.soqlAssistant,
    query: model.queryInput?.value || model.getCurrentTabQuery(),
    onRefresh: () => model.autocompleteReload()
  });
}

// Rendering and transient search controls only; all assistant state lives in its controller.
export default class SoqlPromptPanel extends React.Component {
  constructor(props) {
    super(props);
    this.state = {objectSearch: "", relatedSearch: ""};
  }

  renderCommonFields(assistant) {
    const {draft} = assistant;
    return h("fieldset", {},
      h("legend", {}, "Common fields"),
      h("p", {}, "Save your personal key fields for this org and object. Their order is preserved in the prompt."),
      h("label", {}, "Add a direct field",
        h("select", {value: "", disabled: !draft.describe || draft.loading, onChange: event => assistant.addCommonField(event.target.value)},
          h("option", {value: ""}, "Select a field to add"),
          (draft.describe?.fields || []).filter(field => !draft.commonFields.includes(field.name)).map(field =>
            h("option", {key: field.name, value: field.name}, `${field.label} (${field.name})`)
          )
        )
      ),
      draft.commonFields.length === 0 && h("p", {className: "soql-prompt-notice"},
        "Key fields are not configured. Specify the fields in your request or save common fields first."),
      h("ol", {className: "soql-prompt-common-fields"}, draft.commonFields.map((path, index) =>
        h("li", {key: path},
          h("code", {}, path),
          h("div", {className: "soql-prompt-actions"},
            h("button", {type: "button", disabled: index === 0, onClick: () => assistant.moveCommonField(index, -1), "aria-label": `Move ${path} up`}, "↑"),
            h("button", {type: "button", disabled: index === draft.commonFields.length - 1, onClick: () => assistant.moveCommonField(index, 1), "aria-label": `Move ${path} down`}, "↓"),
            h("button", {type: "button", onClick: () => assistant.removeCommonField(path), "aria-label": `Remove common field ${path}`}, "Remove")
          )
        )
      )),
      h("div", {className: "soql-prompt-actions"},
        h("button", {type: "button", disabled: !assistant.canSave, onClick: () => assistant.saveCommonFields()}, "Save common fields"),
        h("button", {type: "button", disabled: !draft.object, onClick: () => assistant.clearCommonFields()}, "Clear common fields")
      ),
      draft.storageStatus && h("p", {role: "status"}, draft.storageStatus)
    );
  }

  renderRelatedFields(assistant) {
    const {draft} = assistant;
    const relationships = draft.describe ? getParentRelationships(draft.describe) : [];
    const selected = relationships.find(field => field.relationshipName === draft.relationship);
    const target = selected && draft.relatedDescribes.get(selected.referenceTo[0]);
    return h("fieldset", {},
      h("legend", {}, "Related fields"),
      h("p", {}, "Select one parent relationship to load its direct fields. Polymorphic and deeper paths are not supported."),
      h("label", {}, "Parent relationship",
        h("select", {value: draft.relationship,
          disabled: !draft.describe,
          onChange: event => {
            this.setState({relatedSearch: ""});
            assistant.selectRelationship(event.target.value);
          }},
        h("option", {value: ""}, "Select a relationship"),
        relationships.map(field => h("option", {key: field.relationshipName, value: field.relationshipName}, `${field.relationshipName} → ${field.referenceTo[0]}`)))
      ),
      draft.relationshipError && h("p", {role: "alert", className: "soql-prompt-error"}, draft.relationshipError),
      target && h("div", {},
        h("label", {}, "Search related fields",
          h("input", {type: "search", value: this.state.relatedSearch, onChange: event => this.setState({relatedSearch: event.target.value})})
        ),
        h("div", {className: "soql-prompt-field-list"}, target.fields.filter(field => matchesSearch(field, this.state.relatedSearch)).map(field => {
          const path = `${draft.relationship}.${field.name}`;
          return h("div", {key: path, className: "soql-prompt-field-row"},
            h("label", {},
              h("input", {type: "checkbox", checked: draft.relatedFields.includes(path), onChange: event => assistant.setRelatedField(path, event.target.checked)}),
              `${field.label} (${path})`
            ),
            h("button", {type: "button", disabled: draft.commonFields.includes(path), onClick: () => assistant.addCommonField(path)}, "Add to common fields")
          );
        }))
      ),
      h("ul", {className: "soql-prompt-selected-fields"}, draft.relatedFields.map(path =>
        h("li", {key: path}, h("code", {}, path),
          h("button", {type: "button", onClick: () => assistant.setRelatedField(path, false), "aria-label": `Remove related field ${path}`}, "Remove"))
      ))
    );
  }

  render() {
    const {assistant, query, onRefresh} = this.props;
    const {draft} = assistant;
    const search = this.state.objectSearch;
    const objects = assistant.objects.filter(object => object.name === draft.object || matchesSearch(object, search));
    return h("div", {className: "soql-prompt-assistant"},
      h("button", {type: "button", "aria-expanded": draft.open, "aria-controls": "soql-prompt-panel", onClick: () => assistant.toggle(query)}, "Copy prompt for Gemini"),
      draft.open && h("section", {id: "soql-prompt-panel", className: "soql-prompt-panel", "aria-label": "Copy prompt for Gemini"},
        h("div", {className: "soql-prompt-heading"},
          h("h2", {}, "Copy prompt for Gemini"),
          h("button", {type: "button", onClick: () => assistant.toggle(query)}, "Close panel")
        ),
        h("p", {}, "Copy the prompt into Gemini, then paste the generated SOQL into the query editor and click Export. The prompt includes object and field metadata. This extension does not send it to Gemini automatically."),
        h("div", {className: "soql-prompt-object-controls"},
          h("label", {}, "Search objects",
            h("input", {type: "search", value: search, onChange: event => this.setState({objectSearch: event.target.value})})
          ),
          h("label", {}, "Object",
            h("select", {value: draft.object, onChange: event => assistant.selectObject(event.target.value)},
              h("option", {value: ""}, "Select an object"),
              objects.map(object => h("option", {key: object.name, value: object.name}, `${object.label} (${object.name})`))
            )
          ),
          h("button", {type: "button", onClick: onRefresh}, "Refresh metadata")
        ),
        h("label", {className: "soql-prompt-request"}, "Describe your query",
          h("textarea", {value: draft.request, required: true, rows: 3, placeholder: "查询 User 的关键字段，只看启用的用户，按姓名排序", onChange: event => assistant.setRequest(event.target.value)})
        ),
        h("div", {className: "soql-prompt-field-controls"}, this.renderCommonFields(assistant), this.renderRelatedFields(assistant)),
        h("details", {},
          h("summary", {}, "Include picklist values (optional)"),
          h("p", {}, "Include API values and labels for enum conditions in your request. Values are omitted for other fields."),
          h("div", {className: "soql-prompt-field-list"}, assistant.picklistOptions.map(path =>
            h("label", {key: path},
              h("input", {type: "checkbox", checked: draft.picklistFields.includes(path), onChange: event => assistant.setPicklistField(path, event.target.checked)}), path)
          ))
        ),
        h("div", {role: "status", "aria-live": "polite", className: "soql-prompt-status"}, assistant.status),
        h("ul", {className: "soql-prompt-errors"}, draft.fieldErrors.map(error =>
          h("li", {key: error.path}, `${error.path}: ${error.message}`,
            h("button", {type: "button", onClick: () => assistant.removeUnavailableField(error.path), "aria-label": `Remove unavailable field ${error.path}`}, "Remove")
          )
        )),
        (draft.error || draft.relationshipError || draft.fieldErrors.length > 0) && h("button", {type: "button", onClick: onRefresh}, "Retry metadata"),
        h("details", {open: true},
          h("summary", {}, "Preview prompt"),
          h("p", {}, `${draft.fieldCount.toLocaleString()} fields · ${draft.prompt.length.toLocaleString()} characters`),
          draft.prompt.length > LONG_PROMPT_THRESHOLD && h("p", {className: "soql-prompt-notice"},
            "This prompt is longer than 100,000 characters. Consider reducing related fields or auxiliary information. This is a product warning, not a Gemini context limit. The full prompt is preserved."),
          h("textarea", {className: "soql-prompt-preview", "aria-label": "Full prompt preview", readOnly: true, value: draft.prompt, rows: 10}),
          draft.copyFailed && h("button", {type: "button",
            onClick: event => {
              const preview = event.target.closest("details").querySelector("textarea");
              preview.focus();
              preview.select();
            }}, "Select full prompt for manual copy")
        ),
        h("div", {className: "soql-prompt-footer"},
          h("div", {className: "soql-prompt-actions"},
            h("button", {type: "button", disabled: !assistant.canCopy, className: "highlighted", onClick: () => assistant.copy()}, "Copy prompt for Gemini"),
            h("a", {className: "button", href: "https://gemini.google.com/", target: "_blank", rel: "noopener noreferrer"}, "Open Gemini")
          ),
          draft.copyStatus && h("p", {role: "status", className: draft.copyFailed ? "soql-prompt-error" : ""}, draft.copyStatus)
        )
      )
    );
  }
}
