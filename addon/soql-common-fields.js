const VERSION = 1;

// Store only ordered field paths, scoped to this browser, host, object and Data API.
export class CommonFieldsStore {
  constructor(sfHost, storage = localStorage) {
    this.sfHost = sfHost;
    this.storage = storage;
  }

  key(object) {
    return `soqlPromptCommonFields:v${VERSION}:${encodeURIComponent(this.sfHost)}:data:${encodeURIComponent(object)}`;
  }

  load(object) {
    const raw = this.storage.getItem(this.key(object));
    if (raw === null) {
      return [];
    }
    let config;
    try {
      config = JSON.parse(raw);
    } catch {
      throw new Error("Saved common fields could not be read. Clear the configuration and save it again.");
    }
    if (config?.version !== VERSION || config.apiMode !== "data" || config.object !== object
      || !Array.isArray(config.fields) || config.fields.some(field => typeof field !== "string" || !field)
      || new Set(config.fields).size !== config.fields.length) {
      throw new Error("Saved common fields have an invalid format. Clear the configuration and save it again.");
    }
    return [...config.fields];
  }

  save(object, fields) {
    this.storage.setItem(this.key(object), JSON.stringify({version: VERSION, apiMode: "data", object, fields: [...fields]}));
  }

  clear(object) {
    this.storage.removeItem(this.key(object));
  }
}
