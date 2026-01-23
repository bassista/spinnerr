import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";

//----------------------------------------------------------------
// Configuration
//----------------------------------------------------------------
export const CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "../config", "config.json");

//----------------------------------------------------------------
// Log function (imported from server)
//----------------------------------------------------------------
let logFunction = console.log;

export function setLogFunction(log) {
  logFunction = log;
}

function log(message) {
  logFunction(message);
}

//----------------------------------------------------------------
// Load configuration
//----------------------------------------------------------------
export function loadConfig() {
  try {
    const data = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    log(`Error loading config: ${e.message}`);
    return { containers: [], groups: [], schedules: [] };
  }
}

//----------------------------------------------------------------
// Initialize application state
//----------------------------------------------------------------
export function initializeAppState(lastActivity) {
  const config = loadConfig();
  
  // Initialize lastActivity for each container
  if (config.containers) {
    for (const container of config.containers) {
      if (!(container.name in lastActivity)) {
        lastActivity[container.name] = null;
      }
    }
  }

  return {
    containers: config.containers || [],
    groups: config.groups || [],
    schedules: config.schedules || []
  };
}

//----------------------------------------------------------------
// Setup configuration reload
//----------------------------------------------------------------
export function setupConfigReload(onConfigReload) {
  const watcher = fs.watchFile(CONFIG_PATH, () => {
    const newConfig = loadConfig();
    if (newConfig.containers && newConfig.groups && newConfig.schedules) {
      log("Configuration reloaded");
      onConfigReload(newConfig);
    }
  });

  return () => {
    watcher.stop();
  };
}

//----------------------------------------------------------------
// Cleanup removed containers
//----------------------------------------------------------------
export function cleanupRemovedContainers(newContainers, { lastActivity }) {
  const newNames = new Set(newContainers.map(c => c.name));
  
  for (const name in lastActivity) {
    if (!newNames.has(name)) {
      delete lastActivity[name];
      log(`Cleaned up lastActivity for removed container: ${name}`);
    }
  }
}
