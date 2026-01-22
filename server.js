import express from "express";
import { exec } from "child_process";
import path from "path";
import fs from "fs";
import containerRoutes from "./routes/containerRoutes.js"; 
import groupRoutes from "./routes/groupRoutes.js";
import scheduleRoutes from "./routes/scheduleRoutes.js";

//----------------------------------------------------------------
// Constants and Configuration
//----------------------------------------------------------------
const CONFIG_PATH = "/app/config/config.json";
const WAITING_PAGE = "/app/public/waiting.html";
const PORT = process.env.PORT || 10000;
const UI_PORT = process.env.UI_PORT || null;
const DOCKER_PROXY_URL = process.env.DOCKER_PROXY_URL || null;
const HAS_SOCKET = fs.existsSync("/var/run/docker.sock");

let cachedWaitingPageContent = "";
try {
  cachedWaitingPageContent = fs.readFileSync(WAITING_PAGE, 'utf8');
} catch (e) {
  log(`Warning: waiting.html not found at ${WAITING_PAGE}`);
}

//----------------------------------------------------------------
// Log function
//----------------------------------------------------------------
function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

//----------------------------------------------------------------
// Load configuration
//----------------------------------------------------------------
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const defaultConfig = {
      containers: [],
      order: [],
      groups: [],
      groupOrder: [],
      schedules: []
    };
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2));
    log("No config.json found — created default config");
    return defaultConfig;
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH));
}

//----------------------------------------------------------------
// Initialize application state
//----------------------------------------------------------------
const config = loadConfig();
let containers = config.containers;
let groups = config.groups;
let schedules = config.schedules || [];

const lastActivity = {};
const stoppingContainers = new Set();
const recentlyStarted = new Map();
const logOnce = {};

// Initialize lastActivity timestamps
containers.forEach(c => lastActivity[c.name] = Date.now());

//----------------------------------------------------------------
// Setup Docker connection method
//----------------------------------------------------------------
let dockerMethod = "none";
if (HAS_SOCKET && DOCKER_PROXY_URL) {
  dockerMethod = "proxy";
  log("Both socket and proxy defined, defaulted to PROXY");
} else if (HAS_SOCKET) {
  dockerMethod = "socket";
  log("Using SOCKET");
} else if (DOCKER_PROXY_URL) {
  dockerMethod = "proxy";
  log("Using PROXY");
} else {
  log("No socket or proxy found, please mount the docker socket or define a docker proxy");
}

//-----------------------------------------------------------------
// Docker Functions
//----------------------------------------------------------------
async function executeDockerCommand(command) {
  return new Promise((resolve) => {
    exec(command, { timeout: 3000 }, (error, stdout, stderr) => {
      resolve({ error, stdout: stdout?.toString().trim(), stderr });
    });
  });
}

async function isContainerRunning(name) {
  if (dockerMethod === "socket") {
    const { stdout } = await executeDockerCommand(`docker inspect -f '{{.State.Running}}' ${name}`);
    return stdout === "true";
  } else if (dockerMethod === "proxy") {
    try {
      const res = await fetch(
        `${DOCKER_PROXY_URL.replace("tcp://", "http://")}/containers/${name}/json`,
        { signal: AbortSignal.timeout(3000) }
      );
      const data = await res.json();
      return data.State.Running;
    } catch (e) {
      if (e.name === 'AbortError') {
        log(`Timeout in isContainerRunning for ${name}`);
      } else {
        log(`Error in isContainerRunning for ${name}: ${e.message}`);
      }
      return false;
    }
  }
  return false;
}

async function allContainers() {
  if (dockerMethod === "socket") {
    const { stdout } = await executeDockerCommand("docker ps -a --format '{{.Names}}'");
    return stdout ? stdout.split('\n').filter(Boolean) : [];
  } else if (dockerMethod === "proxy") {
    try {
      const res = await fetch(
        `${DOCKER_PROXY_URL.replace("tcp://", "http://")}/containers/json?all=1`,
        { signal: AbortSignal.timeout(3000) }
      );
      const containers = await res.json();
      return containers.map(c => c.Names[0].replace(/^\//, ''));
    } catch (e) {
      if (e.name === 'AbortError') {
        log(`Timeout in allContainers`);
      } else {
        log(`Error in allContainers: ${e.message}`);
      }
      return [];
    }
  }
  return [];
}

async function checkStartTime(name, idleTimeout) {
  const now = Date.now();
  let startTimeStr;

  try {
    if (dockerMethod === "socket") {
      const { stdout } = await executeDockerCommand(`docker inspect -f '{{.State.StartedAt}}' ${name}`);
      startTimeStr = stdout;
    } else if (dockerMethod === "proxy") {
      const res = await fetch(
        `${DOCKER_PROXY_URL.replace("tcp://", "http://")}/containers/${name}/json`,
        { signal: AbortSignal.timeout(3000) }
      );
      const containerInfo = await res.json();
      startTimeStr = containerInfo.State.StartedAt;
    } else {
      return false;
    }

    const startTime = new Date(startTimeStr).getTime();
    
    if (!logOnce[name]) {
      log(`<${name}> checking start time (${idleTimeout}s timeout)`);
      if (!(now - startTime > idleTimeout * 1000)) {
        log(`<${name}> will stop once timeout reaches from start time`);
      }
      logOnce[name] = true;
    }

    return now - startTime > idleTimeout * 1000;
  } catch (e) {
    if (e.name === 'AbortError') {
      log(`Timeout checking start time for ${name}`);
    } else {
      log(`Error checking start time for ${name}: ${e.message}`);
    }
    return false;
  }
}

async function startContainer(name) {
  if (await isContainerRunning(name)) return;

  try {
    if (dockerMethod === "socket") {
      await executeDockerCommand(`docker start ${name}`);
    } else if (dockerMethod === "proxy") {
      await executeDockerCommand(`curl -s -X POST ${DOCKER_PROXY_URL.replace("tcp://", "http://")}/containers/${name}/start`);
    }
    log(`<${name}> started`);
  } catch (e) {
    log(`Failed to start ${name}: ${e.message}`);
  }
}

async function stopContainer(name) {
  if (!(await isContainerRunning(name))) return;

  try {
    log(`<${name}> stopping..`);
    if (dockerMethod === "socket") {
      await executeDockerCommand(`docker stop ${name}`);
    } else if (dockerMethod === "proxy") {
      await executeDockerCommand(`curl -s -X POST ${DOCKER_PROXY_URL.replace("tcp://", "http://")}/containers/${name}/stop`);
    }
  } catch (e) {
    log(`Failed to stop ${name}: ${e.message}`);
  }
}

async function checkMultipleContainers(containerNames, maxConcurrent = 10) {
  const results = {};
  
  for (let i = 0; i < containerNames.length; i += maxConcurrent) {
    const batch = containerNames.slice(i, i + maxConcurrent);
    const promises = batch.map(async (name) => {
      try {
        results[name] = await isContainerRunning(name);
      } catch {
        results[name] = false;
      }
    });
    await Promise.all(promises);
  }
  
  return results;
}

//----------------------------------------------------------------
// Utility Functions
//----------------------------------------------------------------
//TODO activatedAt never set?!?
function checkActivationTime(name, idleTimeout) {
  const activatedAt = containers.find(c => c.name === name)?.activatedAt;
  return activatedAt ? Date.now() - activatedAt > idleTimeout * 1000 : false;
}

function isContainerInGroup(name, groups) {
  return groups.some(g => 
    g.active && 
    g.container && 
    (Array.isArray(g.container) ? g.container.includes(name) : g.container === name)
  );
}

//----------------------------------------------------------------
// Container Lookup
//----------------------------------------------------------------
function findContainerByRequest(req, preferHeader = false) {
  const hostname = preferHeader ? req.headers.host : (req.hostname || req.headers.host);
  
  // First try to find by hostname
  let container = containers.find(c => c.host === hostname);
  if (container) return container;
  
  // If not found, try to find by path
  const pathSegments = req.path?.split('/').filter(Boolean);
  if (pathSegments && pathSegments.length > 0) {
    const firstPathSegment = pathSegments[0];
    container = containers.find(c => c.path === firstPathSegment);
    if (container) {
      log(`<${container.name}> accessed via path prefix /${firstPathSegment}`);

      return container;
    }
  }
  log(`No container found for hostname: ${hostname}, path: ${req.path} - preferHeader: ${preferHeader}`);

  return null;
}

//-----------------------------------------------------------------
// Express App Setup
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

// Check if container is ready
app.get("/api/containers/:name/ready", async (req, res) => {
  const container = containers.find(c => c.name === req.params.name);
  if (!container) return res.status(404).json({ ready: false });
  
  if (!(await isContainerRunning(container.name))) {
    return res.json({ ready: false });
  }
  
  // Verify container is actually responding with 200
  try {
    const response = await fetch(`${container.url}/`, { 
      method: 'GET',
      signal: AbortSignal.timeout(5000)
    });
    res.json({ ready: response.status === 200 });
  } catch (e) {
    if (e.name === 'AbortError') {
      log(`Timeout checking readiness for ${container.name}`);
    } else {
      log(`Error checking readiness for ${container.name}: ${e.message}`);
    }
    res.json({ ready: false });
  }  
});

//----------------------------------------------------------------
// Main proxy middleware
//----------------------------------------------------------------
app.use(async (req, res, next) => {
  const container = findContainerByRequest(req);
  if (!container) {
    log(`No container matched for request: ${req.hostname || req.headers.host}${req.path}`);
    return res.status(404).send("Container not found");
  }

  log(`<${container.name}> accessed`);
  lastActivity[container.name] = Date.now();

  // Find active group containing this container
  const group = groups.find(g =>
    g.active &&
    g.container &&
    (Array.isArray(g.container)
      ? g.container.includes(container.name)
      : g.container === container.name)
  );

  if (!container.path || !container.host) {
      log(`<${container.name}> missing path or host configuration`);
      return res.status(500).send("Container misconfigured");
  }

  const redirectUrl = `https://${container.path}.${container.host}`;
  const waitingPageContent = cachedWaitingPageContent
                               .replace('{{REDIRECT_URL}}', redirectUrl)
                               .replace('{{CONTAINER_NAME}}', container.name);

  // If container is running, redirect request
  if (await isContainerRunning(container.name)) {
    log(`<${container.name}> is running, send waiting page for container at ${redirectUrl}`);
    //we do not redirect directly to allow time for the container to be fully ready and avoid CORS issues
    res.type('text/html').send(waitingPageContent);
    return;    
  }

  if (container.active === false) 
      return res.status(403).send("Container is disabled");

  log(`<${container.name}> is not running, sending waiting page`);
  res.type('text/html').send(waitingPageContent);

  if (recentlyStarted.has(container.name)) {
    log(`<${container.name}> was started recently, not starting again`);
    return;
  }

  const timeoutId = setTimeout(() => recentlyStarted.delete(container.name), 30000);
  recentlyStarted.set(container.name, { startedAt: Date.now(), timeoutId });

  //TODO rivedere la logica del gruppo, non voglio che venga usato sempre, ma solo se viene chiamato il gruppo e poi redirect ad un container di default nel gruppo
  if (group) {
      const names = Array.isArray(group.container) ? group.container : [group.container];
      log(`starting group <${group.name}>`);      
      for (const name of names) {
        const containerInGroup = containers.find(c => c.name === name);
        if (!containerInGroup?.active) {
             log(`<${name}> in group <${group.name}> is not active, skipping`);
             continue;
        }
        if (!(await isContainerRunning(name))) 
            await startContainer(name);
      }
  } else {
      await startContainer(container.name);
  }
  
});

//----------------------------------------------------------------
// Timeout handling interval
//----------------------------------------------------------------
setInterval(async () => {
  try {
    const now = Date.now();
    const containerStatus = await checkMultipleContainers(containers.map(c => c.name));
    
    // Individual container timeout
    for (const c of containers) {
      if (!c.active || !c.idleTimeout || isContainerInGroup(c.name, groups)) continue;
      
      if (lastActivity[c.name] === undefined) {
        lastActivity[c.name] = now;
        continue;  // Salta questo ciclo, non può timeout subito
      }

      const isRunning = containerStatus[c.name];
      const timeoutReached = now - lastActivity[c.name] > (c.idleTimeout || 60) * 1000;
      const activationTimeOk = checkActivationTime(c.name, c.idleTimeout);
      
      if (isRunning && timeoutReached && 
          (await checkStartTime(c.name, c.idleTimeout)) &&
          activationTimeOk &&
          !stoppingContainers.has(c.name)) {
        
        log(`<${c.name}> ${c.idleTimeout || 60}s timeout reached`);
        stoppingContainers.add(c.name);
        await stopContainer(c.name);
        stoppingContainers.delete(c.name);
        logOnce[c.name] = false;
      }
    }
    
    // Group timeout
    for (const g of groups) {
      if (!g.active || !g.idleTimeout || !g.container) continue;

      const groupContainers = Array.isArray(g.container) ? g.container : [g.container];
      const containerChecks = await Promise.all(groupContainers.map(async (name) => {
        const isRunning = containerStatus[name];
        const container = containers.find(c => c.name === name);
        return isRunning && 
              container?.active &&
              now - lastActivity[name] > (g.idleTimeout || 60) * 1000 &&
              (await checkStartTime(name, g.idleTimeout));
      }));

      const shouldStopGroup = containerChecks.every(check => check === true);
      
      if (shouldStopGroup) {
        for (const name of groupContainers) {
          const container = containers.find(c => c.name === name);
          if (containerStatus[name] && container?.active && !stoppingContainers.has(name)) {
            stoppingContainers.add(name);
            await stopContainer(name);
            stoppingContainers.delete(name);
            log(`<${name}> stopped as part of group <${g.name}>`);
          }
        }
      }
    }
  } catch (error) {
    log(`Error in timeout interval: ${error.message}`);
  }
}, 10000);

//----------------------------------------------------------------
// Schedule handling interval
//----------------------------------------------------------------
setInterval(async () => {
  const now = new Date();
  const day = now.getDay();
  const time = now.toTimeString().slice(0, 5);

  for (const s of schedules) {
    const target = s.targetType === "container"
      ? containers.find(c => c.name === s.target)
      : groups.find(g => g.name === s.target);

    if (!target?.active || !s.timers?.length) continue;

    for (const timer of s.timers) {
      if (!timer.active || !timer.days.includes(day)) continue;

      if (timer.startTime === time) {
        if (s.targetType === "container") {
          await startContainer(s.target);
        } else {
          const containerNames = Array.isArray(target.container) ? target.container : [target.container];
          for (const name of containerNames) {
            await startContainer(name);
          }
        }
        log(`<${s.target}> scheduled start executed`);
      }

      if (timer.stopTime === time) {
        const containerNames = s.targetType === "container" 
          ? [s.target]
          : (Array.isArray(target.container) ? target.container : [target.container]);
        
        for (const name of containerNames) {
          if (!stoppingContainers.has(name)) {
            stoppingContainers.add(name);
            await stopContainer(name);
            stoppingContainers.delete(name);
            log(`<${name}> scheduled stop executed`);
          } else {
            log(`<${name}> is already stopping, skipping scheduled stop`);
          }
        }
      }
    }
  }
}, 59000);

//----------------------------------------------------------------
// Configuration reload
//----------------------------------------------------------------
function reloadConfig() {
  try {
    const newConfig = JSON.parse(fs.readFileSync(CONFIG_PATH));
    
    //cleanup lastActivity for removed containers
    for (const name of Object.keys(lastActivity)) {
      if (!newConfig.containers.find(c => c.name === name)) {
        delete lastActivity[name];
      }
    }

    newConfig.containers.forEach(c => {
      if (lastActivity[c.name] === undefined) {
        lastActivity[c.name] = Date.now();
      }
    });

    groups = newConfig.groups;
    containers = newConfig.containers;
    schedules = newConfig.schedules;
    log("Config reloaded, containers updated");
  } catch (e) {
    log(`Failed to reload config: ${e.message}`);
  }
}

fs.watchFile(CONFIG_PATH, { interval: 500 }, reloadConfig);

//----------------------------------------------------------------
// Web UI Server
//----------------------------------------------------------------
if (UI_PORT) {
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

//----------------------------------------------------------------
// Start main server
//----------------------------------------------------------------
const server = app.listen(PORT, () => {
  log(`Spinnerr Proxy running on port ${PORT}`);
});
