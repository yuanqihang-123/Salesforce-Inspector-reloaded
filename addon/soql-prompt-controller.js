import {SoqlMetadata, inferQueryObject} from "./soql-metadata.js";
import {CommonFieldsStore} from "./soql-common-fields.js";
import {buildContext, buildPrompt, getParentRelationships, resolveFieldPath, validateFieldPaths} from "./soql-prompt.js";

function createDraft() {
  return {
    open: false,
    initialized: false,
    object: "",
    request: "",
    inferenceQuery: "",
    commonFields: [],
    fieldsDirty: false,
    configLoaded: false,
    configError: "",
    relatedFields: [],
    relationship: "",
    picklistFields: [],
    describe: null,
    relatedDescribes: new Map(),
    relationshipError: "",
    loading: false,
    error: "",
    fieldErrors: [],
    prompt: "",
    fieldCount: 0,
    copyStatus: "",
    copyFailed: false,
    copying: false,
    storageStatus: ""
  };
}

// Owns only assistant state. Query text, export results and persisted query tabs
// remain owned by Data Export. WeakMap keys follow tabs even when tabs are removed.
export class SoqlPromptController {
  constructor({sfHost, describeInfo, onUpdate, copy, storage}) {
    this.describeInfo = describeInfo;
    this.metadata = new SoqlMetadata(describeInfo);
    this.store = new CommonFieldsStore(sfHost, storage);
    this.onUpdate = onUpdate;
    this.copyText = copy;
    this.drafts = new WeakMap();
    this.objects = [];
    this.version = 0;
    this.draft = null;
    this.tooling = false;
    this.unsubscribe = describeInfo.subscribe(event => {
      if (event === "reload" && this.draft) {
        this.draft.describe = null;
        this.draft.relatedDescribes = new Map();
        if (!this.draft.fieldsDirty) {
          this.draft.configLoaded = false;
          this.draft.configError = "";
        }
        this.prepare();
      }
    });
  }

  activate(tab, tooling) {
    if (this.tab === tab && this.tooling === tooling) {
      return;
    }
    this.invalidate();
    this.tab = tab;
    this.tooling = tooling;
    if (!this.drafts.has(tab)) {
      this.drafts.set(tab, createDraft());
    }
    this.draft = this.drafts.get(tab);
    if (!this.draft.fieldsDirty) {
      this.draft.configLoaded = false;
      this.draft.configError = "";
    }
    this.prepare();
  }

  setTooling(tooling) {
    if (this.tooling !== tooling) {
      this.tooling = tooling;
      this.prepare();
    }
  }

  invalidate() {
    this.version++;
    this.abortController?.abort();
    if (this.draft) {
      this.draft.prompt = "";
      this.draft.copyStatus = "";
      this.draft.copyFailed = false;
      this.draft.copying = false;
      this.draft.loading = false;
    }
  }

  toggle(query) {
    this.draft.open = !this.draft.open;
    if (this.draft.open && !this.draft.initialized) {
      this.draft.inferenceQuery = query;
    }
    return this.prepare();
  }

  selectObject(object) {
    const draft = this.draft;
    draft.initialized = true;
    draft.object = object;
    draft.commonFields = [];
    draft.fieldsDirty = false;
    draft.configLoaded = false;
    draft.configError = "";
    draft.relatedFields = [];
    draft.relationship = "";
    draft.picklistFields = [];
    draft.describe = null;
    draft.relatedDescribes = new Map();
    draft.storageStatus = "";
    return this.prepare();
  }

  setRequest(request) {
    this.draft.request = request;
    return this.prepare();
  }

  selectRelationship(relationship) {
    this.draft.relationship = relationship;
    return this.prepare();
  }

  setRelatedField(path, selected) {
    const fields = this.draft.relatedFields.filter(field => field !== path);
    this.draft.relatedFields = selected ? [...fields, path] : fields;
    return this.prepare();
  }

  setPicklistField(path, selected) {
    const fields = this.draft.picklistFields.filter(field => field !== path);
    this.draft.picklistFields = selected ? [...fields, path] : fields;
    return this.prepare();
  }

  addCommonField(path) {
    if (!path || this.draft.commonFields.includes(path)) {
      return Promise.resolve();
    }
    this.draft.commonFields.push(path);
    this.draft.fieldsDirty = true;
    this.draft.storageStatus = "";
    return this.prepare();
  }

  removeCommonField(path) {
    this.draft.commonFields = this.draft.commonFields.filter(field => field !== path);
    this.draft.fieldsDirty = true;
    this.draft.storageStatus = "";
    return this.prepare();
  }

  removeUnavailableField(path) {
    this.draft.relatedFields = this.draft.relatedFields.filter(field => field !== path);
    this.draft.picklistFields = this.draft.picklistFields.filter(field => field !== path);
    if (this.draft.commonFields.includes(path)) {
      return this.removeCommonField(path);
    }
    return this.prepare();
  }

  moveCommonField(index, direction) {
    const fields = this.draft.commonFields;
    const target = index + direction;
    if (target >= 0 && target < fields.length) {
      [fields[index], fields[target]] = [fields[target], fields[index]];
      this.draft.fieldsDirty = true;
      this.draft.storageStatus = "";
    }
    return this.prepare();
  }

  saveCommonFields() {
    if (!this.canSave) {
      return;
    }
    try {
      this.store.save(this.draft.object, this.draft.commonFields);
      this.draft.fieldsDirty = false;
      this.draft.storageStatus = "Common fields saved for this org and object.";
    } catch (error) {
      this.draft.storageStatus = `Could not save common fields: ${error.message}`;
    }
    this.onUpdate();
  }

  clearCommonFields() {
    try {
      this.store.clear(this.draft.object);
      this.draft.commonFields = [];
      this.draft.configError = "";
      this.draft.fieldsDirty = false;
      this.draft.storageStatus = "Common fields cleared.";
      this.prepare();
    } catch (error) {
      this.draft.storageStatus = `Could not clear common fields: ${error.message}`;
      this.onUpdate();
    }
  }

  refresh() {
    this.describeInfo.reloadAll();
  }

  get canSave() {
    const draft = this.draft;
    return !!draft?.describe && !this.tooling && !draft.loading && !draft.error && !draft.configError
      && validateFieldPaths(draft.describe, draft.relatedDescribes, draft.commonFields).length === 0;
  }

  get canCopy() {
    const draft = this.draft;
    return !!draft?.open && !!draft.prompt && !this.tooling && !draft.loading && !draft.fieldsDirty && !draft.copying;
  }

  get status() {
    const draft = this.draft;
    if (this.tooling) { return "This assistant does not support Tooling API mode. Switch to the Data API to copy a prompt."; }
    if (draft.loading) { return "Loading metadata..."; }
    if (draft.error) { return draft.error; }
    if (!draft.object) { return "Select an object."; }
    if (draft.configError) { return draft.configError; }
    if (draft.fieldErrors.length) { return "Some configured fields are unavailable. Retry or remove the listed fields."; }
    if (draft.fieldsDirty) { return "Save or clear your common fields before copying."; }
    if (!draft.request.trim()) { return "Describe your query before copying."; }
    return "Prompt ready. Review the metadata before copying.";
  }

  get picklistOptions() {
    const draft = this.draft;
    if (!draft.describe) { return []; }
    const paths = [...draft.describe.fields.map(field => field.name), ...draft.commonFields, ...draft.relatedFields];
    return [...new Set(paths)].filter(path => {
      const {field} = resolveFieldPath(draft.describe, draft.relatedDescribes, path);
      return field?.type === "picklist" || field?.type === "multipicklist";
    });
  }

  async prepare() {
    this.invalidate();
    const draft = this.draft;
    if (!draft) { return; }
    draft.error = "";
    draft.fieldErrors = [];
    draft.relationshipError = "";
    draft.fieldCount = 0;
    if (!draft.open || this.tooling) {
      this.onUpdate();
      return;
    }
    const version = this.version;
    this.abortController = new AbortController();
    const {signal} = this.abortController;
    const current = () => this.version === version && this.draft === draft;
    draft.loading = true;
    this.onUpdate();
    try {
      const objects = await this.metadata.loadObjects(signal);
      if (!current()) { return; }
      this.objects = objects;
      if (!draft.initialized) {
        draft.initialized = true;
        draft.object = inferQueryObject(draft.inferenceQuery, objects);
        draft.inferenceQuery = "";
      }
      if (!draft.object) { return; }
      if (!objects.some(object => object.name === draft.object)) {
        throw new Error(`Object ${draft.object} is not available or is not queryable using the Data API.`);
      }
      const describe = await this.metadata.loadObject(draft.object, signal);
      if (!current()) { return; }
      draft.describe = describe;
      if (!describe.queryable) {
        throw new Error(`Object ${describe.name} is not queryable using the Data API.`);
      }
      if (!draft.configLoaded) {
        draft.configLoaded = true;
        try {
          draft.commonFields = this.store.load(describe.name);
        } catch (error) {
          draft.configError = error.message;
        }
      }
      const paths = [...draft.commonFields, ...draft.relatedFields, ...draft.picklistFields];
      const requiredRelationships = new Set(paths.filter(path => path.includes(".")).map(path => path.split(".")[0]));
      const relationships = getParentRelationships(describe).filter(field => requiredRelationships.has(field.relationshipName)
        || field.relationshipName === draft.relationship);
      const targets = [...new Set(relationships.map(field => field.referenceTo[0]))];
      const results = await Promise.allSettled(targets.map(target => this.metadata.loadObject(target, signal)));
      if (!current()) { return; }
      const relatedDescribes = new Map();
      const failures = new Map();
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          relatedDescribes.set(targets[index], result.value);
        } else {
          failures.set(targets[index], result.reason.message);
        }
      });
      draft.relatedDescribes = relatedDescribes;
      const viewed = relationships.find(field => field.relationshipName === draft.relationship);
      draft.relationshipError = failures.get(viewed?.referenceTo[0]) || "";
      draft.fieldErrors = validateFieldPaths(describe, relatedDescribes, paths).map(error => {
        const relationship = relationships.find(field => field.relationshipName === error.path.split(".")[0]);
        return {...error, message: failures.get(relationship?.referenceTo[0]) || error.message};
      });
      if (draft.configError || draft.fieldErrors.length || !draft.request.trim()) { return; }
      const context = buildContext({
        describe,
        relatedDescribes,
        commonFields: draft.commonFields,
        relatedFields: draft.relatedFields,
        picklistFields: draft.picklistFields,
        request: draft.request
      });
      draft.prompt = buildPrompt(context);
      draft.fieldCount = context.fields.length + context.verifiedRelatedFields.length;
    } catch (error) {
      if (current() && error.name !== "AbortError") {
        draft.error = error.message;
      }
    } finally {
      if (current()) {
        draft.loading = false;
        this.onUpdate();
      }
    }
  }

  async copy() {
    if (!this.canCopy) { return; }
    const draft = this.draft;
    const version = this.version;
    const prompt = draft.prompt;
    draft.copying = true;
    draft.copyStatus = "Copying prompt...";
    draft.copyFailed = false;
    this.onUpdate();
    try {
      // Invoke synchronously in the click handler to preserve browser user activation.
      const success = await this.copyText(prompt);
      if (!success) { throw new Error("The browser did not copy the prompt."); }
      if (this.version === version && this.draft === draft) {
        draft.copyStatus = "Prompt copied. Paste it into Gemini.";
      }
    } catch (error) {
      if (this.version === version && this.draft === draft) {
        draft.copyFailed = true;
        draft.copyStatus = `Copy failed: ${error.message} Select the full preview and copy it manually.`;
      }
    } finally {
      if (this.version === version && this.draft === draft) {
        draft.copying = false;
        this.onUpdate();
      }
    }
  }

  dispose() {
    this.invalidate();
    this.unsubscribe();
  }
}
