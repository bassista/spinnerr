import express from "express";
import fs from "fs";
import containerRoutes from "./routes/containerRoutes.js"; 
import groupRoutes from "./routes/groupRoutes.js";
import scheduleRoutes from "./routes/scheduleRoutes.js";
import { setupConfigReload, cleanupRemovedContainers, setLogFunction, initializeAppState } from "./utils/configManager.js";
import { initializeDockerMethod, isContainerRunning, startContainer, stopContainer, allContainers, setLogFunction as setDockerLogFunction } from "./utils/dockerManager.js";
import { initializeScheduler, setLogFunction as setScheduleLogFunction } from "./utils/scheduleManager.js";
import { setLogFunction as setRequestHandlerLogFunction } from "./utils/requestHandler.js";
import { createProxyMiddleware, setLogFunction as setProxyMiddlewareLogFunction } from "./utils/proxyMiddleware.js";
import { setupUIServer, setLogFunction as setUIServerLogFunction } from "./utils/uiServer.js";

//----------------------------------------------------------------
// Constants and Configuration
//----------------------------------------------------------------
const WAITING_PAGE = "/app/public/waiting.html";
const PORT = process.env.PORT || 10000;
const UI_PORT = process.env.UI_PORT || null;
let cachedWaitingPageContent = fs.readFileSync(WAITING_PAGE, 'utf8');

//----------------------------------------------------------------
// Log function
//----------------------------------------------------------------
function log(message) {
  let timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

// Set log function for all modules
setLogFunction(log);
setDockerLogFunction(log);
setScheduleLogFunction(log);
setRequestHandlerLogFunction(log);
setProxyMiddlewareLogFunction(log);
setUIServerLogFunction(log);
initializeDockerMethod();

//----------------------------------------------------------------
// Initialize application state
//----------------------------------------------------------------
const lastActivity = {};
const stoppingContainers = new Set();
const recentlyStarted = new Map();
const appState = initializeAppState(lastActivity);
let containers = appState.containers;
let groups = appState.groups;
let schedules = appState.schedules;

// Initialize scheduler with getters to always get current state
initializeScheduler(
  () => schedules,
  () => containers,
  () => groups,
  startContainer,
  stopContainer,
  stoppingContainers
);

//-----------------------------------------------------------------
// Express Main App Setup
//-----------------------------------------------------------------
const app = express();

// API Routes
app.use("/api/containers", express.json(), containerRoutes);
app.use("/api/groups", express.json(), groupRoutes);
app.use("/api/schedules", express.json(), scheduleRoutes);

// Expose control functions
app.locals.startContainer = startContainer;
app.locals.stopContainer = stopContainer;
app.locals.isContainerRunning = isContainerRunning;
app.locals.lastActivity = lastActivity;

app.use(createProxyMiddleware(containers, groups, lastActivity, recentlyStarted, cachedWaitingPageContent, isContainerRunning, startContainer));

const server = app.listen(PORT, () => {
  log(`Spinnerr Proxy running on port ${PORT}`);
});

//----------------------------------------------------------------
// Web UI Server
//----------------------------------------------------------------
setupUIServer(UI_PORT, isContainerRunning, startContainer, stopContainer, lastActivity, allContainers);

//----------------------------------------------------------------
// Configuration reload setup
//----------------------------------------------------------------
const unwatch = setupConfigReload((newConfig) => {
  // Set log function for configManager
  setLogFunction(log);
  
  // Cleanup removed containers
  cleanupRemovedContainers(newConfig.containers, { lastActivity });

  groups = newConfig.groups;
  containers = newConfig.containers;
  schedules = newConfig.schedules;
});

// Cleanup on process exit
process.on('exit', unwatch);
process.on('SIGINT', () => {
  unwatch();
  process.exit(0);
});