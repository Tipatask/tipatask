'use strict';

// Native notification tags are only unique inside one project. Include the project path so
// equal task keys in separate windows cannot overwrite each other's click destination.
function createNotificationOriginRegistry(maxEntries = 200) {
  const entries = new Map();
  const key = (tag, projectPath) => JSON.stringify([projectPath || null, tag]);

  return {
    remember(tag, origin) {
      if (!tag) return origin;
      const id = key(tag, origin.projectPath);
      entries.delete(id);
      entries.set(id, origin);
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
      return origin;
    },
    get(tag, projectPath) {
      return tag ? entries.get(key(tag, projectPath)) : null;
    },
    forget(tag, projectPath, expected) {
      if (!tag) return;
      const id = key(tag, projectPath);
      if (!expected || entries.get(id) === expected) entries.delete(id);
    },
  };
}

module.exports = { createNotificationOriginRegistry };
