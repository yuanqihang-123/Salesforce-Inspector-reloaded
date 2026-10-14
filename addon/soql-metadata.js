// Await the existing DescribeInfo cache without changing autocomplete's synchronous API.
export class SoqlMetadata {
  constructor(describeInfo) {
    this.describeInfo = describeInfo;
  }

  wait(read, statusKey, valueKey, name, signal) {
    return new Promise((resolve, reject) => {
      let unsubscribe = () => {};
      let finished = false;
      const finish = (error, value) => {
        if (finished) { return; }
        finished = true;
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
        if (error) {
          reject(error);
        } else {
          resolve(value);
        }
      };
      const onAbort = () => finish(new DOMException("Metadata loading cancelled", "AbortError"));
      const check = () => {
        if (finished) { return; }
        const state = read();
        if (state[statusKey] === "ready") {
          finish(null, state[valueKey]);
        } else if (state[statusKey] === "loadfailed" || state[statusKey] === "notfound") {
          finish(new Error(state[statusKey] === "notfound"
            ? `Object ${name} is not available.` : `Could not load ${name} metadata. Retry or refresh metadata.`));
        }
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      unsubscribe = this.describeInfo.subscribe(check);
      signal?.addEventListener("abort", onAbort, {once: true});
      check();
    });
  }

  async loadObjects(signal) {
    const describe = await this.wait(() => this.describeInfo.describeGlobal(false), "globalStatus", "globalDescribe", "object list", signal);
    return describe.sobjects.filter(object => object.queryable).sort((a, b) => a.name.localeCompare(b.name));
  }

  loadObject(name, signal) {
    return this.wait(() => this.describeInfo.describeSobject(false, name), "sobjectStatus", "sobjectDescribe", name, signal);
  }
}

// Only infer an object from a balanced ordinary SELECT with one top-level FROM.
// Mask literals and nested expressions so a subquery or a string cannot supply it.
export function inferQueryObject(query, objects) {
  if (!/^\s*select\b/i.test(query)) {
    return "";
  }
  let depth = 0;
  let quoted = false;
  let topLevel = "";
  for (let index = 0; index < query.length; index++) {
    const character = query[index];
    if (quoted && character === "\\") {
      index++;
      topLevel += "  ";
      continue;
    }
    if (character === "'") {
      quoted = !quoted;
      topLevel += " ";
    } else if (quoted) {
      topLevel += " ";
    } else if (character === "(") {
      depth++;
      topLevel += " ";
    } else if (character === ")") {
      if (--depth < 0) {
        return "";
      }
      topLevel += " ";
    } else {
      topLevel += depth === 0 ? character : " ";
    }
  }
  if (quoted || depth !== 0 || /[{};]/.test(topLevel)) {
    return "";
  }
  const matches = [...topLevel.matchAll(/\bfrom\s+([a-zA-Z][a-zA-Z0-9_]*)(?=\s|$)/gi)];
  if (matches.length !== 1 || /\bselect\b/i.test(topLevel.trim().slice(6))
    || [...topLevel.matchAll(/\bfrom\b/gi)].length !== 1
    || !topLevel.slice(topLevel.toLowerCase().indexOf("select") + 6, matches[0].index).trim()) {
    return "";
  }
  return objects.find(object => object.name.toLowerCase() === matches[0][1].toLowerCase())?.name || "";
}
