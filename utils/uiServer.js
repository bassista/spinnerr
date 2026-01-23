import express from "express";
import containerRoutes from "../routes/containerRoutes.js";
import groupRoutes from "../routes/groupRoutes.js";
import scheduleRoutes from "../routes/scheduleRoutes.js";

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
// Web UI Server Setup
//----------------------------------------------------------------
export function setupUIServer(UI_PORT, isContainerRunning, startContainer, stopContainer, lastActivity, allContainers) {
  if (!UI_PORT) {
    log("WebUI disabled (UI_PORT not set)");    
    return;
  }

  const ui = express();
  ui.use(express.json());
  ui.use("/api/containers", containerRoutes);
  ui.use(express.static("/app/public/ui"));
  ui.use("/api/groups", groupRoutes);
  ui.use("/api/schedules", scheduleRoutes);

  ui.locals.isContainerRunning = isContainerRunning;
  ui.locals.startContainer = startContainer;
  ui.locals.stopContainer = stopContainer;
  ui.locals.lastActivity = lastActivity;
  ui.locals.allContainers = allContainers;

  ui.listen(UI_PORT, () => {
    log(`WebUI running on port ${UI_PORT}`);
  });
}
