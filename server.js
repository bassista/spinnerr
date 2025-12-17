import express from "express";
import { execSync, exec } from "child_process";
import httpProxy from "http-proxy";
import path from "path";
import fs from "fs";
import containerRoutes from "./routes/containerRoutes.js"; 
import groupRoutes from "./routes/groupRoutes.js";
import scheduleRoutes from "./routes/scheduleRoutes.js";
import https from "https";

const app = express();
const waitingPage = path.join("/app/public", "waiting.html");

//----------------------------------------------------------------
// Load configuration or create default if not exists
//----------------------------------------------------------------
const CONFIG_PATH = "/app/config/config.json";
let config;

if (!fs.existsSync(CONFIG_PATH)) {
  // create default config
  const defaultConfig = {
    containers: [],
    order: [],
    groups: [],
    groupOrder: [],
    schedules: [],
    apiKeys: {pve: {}}
  };
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2));
  config = defaultConfig;
  log("No config.json found — created default config");
} else {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH));
}

//----------------------------------------------------------------
// Initialize variables
//----------------------------------------------------------------
const PORT = process.env.PORT || 10000;
let containers = config.containers;
let groups = config.groups;
let schedules = config.schedules || [];
let apiKeys = config.apiKeys || {};
const lastActivity = {};
containers.forEach(c => lastActivity[c.name] = Date.now());
const stoppingContainers = new Set();


//----------------------------------------------------------------
// Create proxy server
//----------------------------------------------------------------
const proxy = httpProxy.createProxyServer({
  ws: true,
  changeOrigin: false
});

// WebSocket fix
proxy.on("proxyReq", (proxyReq, req, res) => {
  if (req.headers.upgrade) {
    proxyReq.setHeader("Connection", "Upgrade");
    proxyReq.setHeader("Upgrade", req.headers.upgrade);
  }
});

// Proxy error handling
proxy.on("error", (err, req, res) => {
  const container = containers.find(c => c.host === req.hostname);
  if (container) {
    log(`<${container.name}> proxy error: ${err.code || err.message}`);
  }

  // If headers are not sent yet, serve the waiting page
  if (!res.headersSent) {
    res.status(502).sendFile(waitingPage);
  }
});


//----------------------------------------------------------------
// Log function
//----------------------------------------------------------------
function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}


//----------------------------------------------------------------
// Check if Proxy or Socket
//----------------------------------------------------------------
const DOCKER_PROXY_URL = process.env.DOCKER_PROXY_URL || null;
const HAS_SOCKET = fs.existsSync("/var/run/docker.sock");

let method;
if(HAS_SOCKET){
  method = "socket";
  log(`Using SOCKET`);
} else if(DOCKER_PROXY_URL){
  method = "proxy";
  log(`Using PROXY`);
} else if (HAS_SOCKET && DOCKER_PROXY_URL){
  method = "proxy";
  log(`Both methods defined, defaulted to PROXY`);
} else {
  log(`No socket or proxy found, please mount the docker socket or define a docker proxy`)
}

//----------------------------------------------------------------------------------------------------------------------------------
//----------------------------------------------------------------------------------------------------------------------------------
// Docker Functions
//----------------------------------------------------------------------------------------------------------------------------------
//----------------------------------------------------------------------------------------------------------------------------------

//----------------------------------------------------------------
// Check if container is running
//----------------------------------------------------------------
async function isContainerRunningDocker(name) {
  if (HAS_SOCKET) {
    return new Promise((resolve) => {
      exec(`docker inspect -f '{{.State.Running}}' ${name}`, 
        { timeout: 2000 },
        (error, stdout, stderr) => {
          if (error || stderr) {
            resolve(false);
          } else {
            resolve(stdout.toString().trim() === "true");
          }
        }
      );
    });
  } else if (DOCKER_PROXY_URL) {
    try {
      const res = await fetch(
        `${DOCKER_PROXY_URL.replace("tcp://", "http://")}/containers/${name}/json`,
        { signal: AbortSignal.timeout(3000) }
      );
      const data = await res.json();
      return data.State.Running;
    } catch {
      return false;
    }
  }
  return false;
}


//----------------------------------------------------------------
// Get all containers from Docker
//----------------------------------------------------------------
async function allContainersDocker() {
  if (HAS_SOCKET) {
    return new Promise((resolve) => {
      exec(`docker ps -a --format '{{.Names}}'`,
        { timeout: 3000 },
        (error, stdout, stderr) => {
          if (error || stderr) {
            resolve([]);
          } else {
            resolve(stdout.toString().trim().split('\n').filter(Boolean));
          }
        }
      );
    });
  } else if (DOCKER_PROXY_URL) {
    try {
      const res = await fetch(
        `${DOCKER_PROXY_URL.replace("tcp://", "http://")}/containers/json?all=1`,
        { signal: AbortSignal.timeout(3000) }
      );
      const containers = await res.json();
      return containers.map(c => c.Names[0].replace(/^\//, ''));
    } catch {
      return [];
    }
  }
  return [];
}


//----------------------------------------------------------------
// New function to check multiple containers' running status in parallel
//----------------------------------------------------------------
async function checkMultipleContainers(containerNames, maxConcurrent = 10) {
  const results = {};
  // Process in batches to avoid too many concurrent calls
  for (let i = 0; i < containerNames.length; i += maxConcurrent) {
    const batch = containerNames.slice(i, i + maxConcurrent);
    const promises = batch.map(async (name) => {
      try {
        const isRunning = await isContainerRunning(name);
        results[name] = isRunning;
      } catch {
        results[name] = false;
      }
    });
    
    await Promise.all(promises);
  }
  
  return results;
}


//----------------------------------------------------------------
// Determine container start time in order to prevent stopping earlier if container was started manually
//----------------------------------------------------------------
let logOnce = true;
function checkStartTimeDocker(name, idleTimeout){
  
  const now = Date.now();
  let startTimeStr;

  if (HAS_SOCKET) {
    try {
      startTimeStr = execSync(`docker inspect -f '{{.State.StartedAt}}' ${name}`).toString().trim();
    } catch(e) {
      console.error('Error checking container via socket:', e.message);
      return false;
    }
  } else if (DOCKER_PROXY_URL) {
    try {
      const res = execSync(`curl -s ${DOCKER_PROXY_URL.replace("tcp://", "http://")}/containers/${name}/json`).toString().trim();
      const containerInfo = JSON.parse(res);
      startTimeStr = containerInfo.State.StartedAt;
    } catch(e) {
      console.error('Error checking container via proxy:', e.message);
      return false;
    }
  } else {
    return false;
  }

  try {
    const startTime = new Date(startTimeStr).getTime();
    
    if (logOnce){
      log(`<${name}> timeout reached from last web request, checking for timeout from START time`);
      if (!(now - startTime > idleTimeout * 1000)){
        log(`<${name}> timeout not reached, will stop once timeout reaches ${idleTimeout} seconds from START time and ACTIVATION time`);
      }
    }

    logOnce = false;

    return (now - startTime > idleTimeout * 1000);
  } catch(e){
    console.error('Error checking container start time:', e.message);
    return false;
  }
}


//----------------------------------------------------------------
// Check if container activation is more than timeout ago
//----------------------------------------------------------------
function checkActivationTime(name, idleTimeout){
  const activatedAt = containers.find(c => c.name === name)?.activatedAt;
  if (!activatedAt) return false;

  const now = Date.now();
  return now - activatedAt > idleTimeout * 1000;
}

//----------------------------------------------------------------
// Check if container is part of a group
//----------------------------------------------------------------
function isContainerInGroup(name, groups) {
  for (const g of groups) {
    if (!g.active) continue;
    if (!g.container) continue;

    if (Array.isArray(g.container)) {
      if (g.container.includes(name)) {
        return true;
      }
    } else {
      if (g.container === name) {
        return true;
      }
    }
  }

  return false;
}


//----------------------------------------------------------------
// Start container function
//----------------------------------------------------------------
async function startContainerDocker(name) {
  if (!(await isContainerRunning(name))) {
    try {
      if (HAS_SOCKET){
        await new Promise((resolve, reject) => {
          exec(`docker start ${name}`, 
            { timeout: 30000 }, // 30 second timeout
            (error, stdout, stderr) => {
              if (error) {
                reject(error);
              } else {
                resolve();
              }});
        });
      } else if (DOCKER_PROXY_URL){
        await new Promise((resolve, reject) => {
          exec(`curl -s -X POST ${DOCKER_PROXY_URL.replace("tcp://", "http://")}/containers/${name}/start`,
            { timeout: 30000 },
            (error, stdout, stderr) => {
              if (error) {
                reject(error);
              } else {
                resolve();
              }});
        });
      }
      log(`<${name}> started`);
    } catch (e) {
      log(`Failed to start ${name}: ${e.message}`);
    }
  }
}


//----------------------------------------------------------------
// Stop container function
//----------------------------------------------------------------
async function stopContainerDocker(name) {
  if (await isContainerRunning(name)) {
    try {
      log(`<${name}> stopping..`);
      if (HAS_SOCKET){
        await new Promise((resolve, reject) => {
          exec(`docker stop ${name}`,
            { timeout: 30000 },
            (error, stdout, stderr) => {
              if (error) {
                reject(error);
              } else {
                resolve();
              }});
        });
      } else if (DOCKER_PROXY_URL){
        await new Promise((resolve, reject) => {
          exec(`curl -s -X POST ${DOCKER_PROXY_URL.replace("tcp://", "http://")}/containers/${name}/stop`,
            { timeout: 30000 },
            (error, stdout, stderr) => {
              if (error) {
                reject(error);
              } else {
                resolve();
              }});
        });
      }
    } catch (e) {
      log(`Failed to stop ${name}: ${e.message}`);
    }
  }
}

//----------------------------------------------------------------------------------------------------------------------------------
//----------------------------------------------------------------------------------------------------------------------------------
// Proxmox LXC Functions
//----------------------------------------------------------------------------------------------------------------------------------
//----------------------------------------------------------------------------------------------------------------------------------

//----------------------------------------------------------------
// Load Proxmox API keys from config
//----------------------------------------------------------------
let pveKeys = config.apiKeys?.pve || null;
let pveHostname = pveKeys?.hostname || null;
let pvePort = pveKeys?.port || null;
let pveNode = pveKeys?.node || null;
let pveUser = pveKeys?.user || null;
let pveTokenId = pveKeys?.tokenId || null;
let pveToken = pveKeys?.token || null;
let pveAuthHeader = pveUser && pveTokenId && pveToken 
  ? `PVEAPIToken=${pveUser}!${pveTokenId}=${pveToken}` 
  : null;

log(`PVE Config: ${pveAuthHeader ? "SET" : "NOT SET"}`);
if (pveAuthHeader) {
  log(`PVE: ${pveHostname}:${pvePort}, node: ${pveNode}`);
}


//----------------------------------------------------------------
// Determine Proxmox LXC start time in order to prevent stopping earlier if container was started manually
//----------------------------------------------------------------
async function checkStartTimeLXC(fullName, idleTimeout) {
  if (!pveAuthHeader) return false;
  
  const lastPart = fullName.split(':').pop();
  const vmid = lastPart.split('@')[0];
  if (!vmid || isNaN(vmid)) return false;

  return new Promise((resolve) => {
    const req = https.request({
      hostname: pveHostname,
      port: pvePort,
      path: `/api2/json/nodes/${pveNode}/lxc/${vmid}/status/current`,
      method: 'GET',
      headers: { 'Authorization': pveAuthHeader },
      rejectUnauthorized: false,
      timeout: 3000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const uptime = json.data?.uptime || 0; // uptime in seconds
          const startTime = Date.now() - (uptime * 1000);
          resolve((Date.now() - startTime) > idleTimeout * 1000);
          if (logOnce){
            log(`LXC <${fullName}> started at ${new Date(startTime).toISOString()}, uptime: ${uptime} seconds`);
          }
          logOnce = false;
        } catch {
          resolve(false);
        }
      });
    });
    
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}


//----------------------------------------------------------------
// Get all LXC containers from Proxmox
//----------------------------------------------------------------
async function allContainersLXC() {
  if (!pveAuthHeader) return [];
  
  return new Promise((resolve) => {
    const req = https.request({
      hostname: pveHostname,
      port: pvePort,
      path: `/api2/json/nodes/${pveNode}/lxc`,
      method: 'GET',
      headers: { 'Authorization': pveAuthHeader },
      rejectUnauthorized: false,
      timeout: 5000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.data.map(c => `${c.name}:${c.vmid}@${pveNode}`));
        } catch {
          resolve([]);
        }
      });
    });
    
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
    
    req.end();
  });
}


//----------------------------------------------------------------
// Check if Proxmox LXC container is running
//----------------------------------------------------------------
async function isContainerRunningLXC(fullName) {
  if (!pveAuthHeader) return false;
  
  // Parse: "ubuntu/100@proxmox" → vmid=100
  // Or: "ubuntu-22.04/101@proxmox" → vmid=101
  const parts = fullName.split(':');
  if (parts.length !== 2) return false;
  
  const namePart = parts[0];  // "ubuntu" or "ubuntu-22.04"
  const vmidNodePart = parts[1];  // "100@proxmox"
  
  const vmidNodeParts = vmidNodePart.split('@');
  if (vmidNodeParts.length !== 2) return false;
  
  const vmid = vmidNodeParts[0];  // "100"
  // const node = vmidNodeParts[1];  // "proxmox" (optional)
  
  if (!vmid || isNaN(parseInt(vmid))) return false;
  
  return new Promise((resolve) => {
    const req = https.request({
      hostname: pveHostname,
      port: pvePort,
      path: `/api2/json/nodes/${pveNode}/lxc/${vmid}/status/current`,
      method: 'GET',
      headers: { 'Authorization': pveAuthHeader },
      rejectUnauthorized: false,
      timeout: 3000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          // Check both possible response formats
          const isRunning = json.data?.status === 'running' || 
                           json.data?.State?.Running === true ||
                           json.status === 'running';
          resolve(isRunning || false);
        } catch {
          resolve(false);
        }
      });
    });
    
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}


//----------------------------------------------------------------
// Start Proxmox LXC container
//----------------------------------------------------------------
async function startContainerLXC(fullName) {
  if (!pveAuthHeader) return false;
  
  const parts = fullName.split(':');
  if (parts.length !== 2) return false;
  
  const vmidNodePart = parts[1];
  const vmidNodeParts = vmidNodePart.split('@');
  if (vmidNodeParts.length !== 2) return false;
  
  const vmid = vmidNodeParts[0];
  if (!vmid || isNaN(parseInt(vmid))) return false;

  try {
    // Send shutdown command
    const startSuccess = await new Promise((resolve) => {
      const req = https.request({
        hostname: pveHostname,
        port: pvePort,
        path: `/api2/json/nodes/${pveNode}/lxc/${vmid}/status/start`,
        method: 'POST',
        headers: { 'Authorization': pveAuthHeader },
        rejectUnauthorized: false,
        timeout: 10000
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode === 200) {
              log(`Start command sent for LXC ${fullName}. Response:`, json);
              resolve(true);
            } else {
              console.error(`Failed to start LXC ${fullName}. API Error:`, json);
              resolve(false);
            }
          } catch (parseError) {
            console.error(`Failed to parse Proxmox API response for ${fullName}:`, parseError);
            resolve(false);
          }
        });
      });
      
      req.on('error', (err) => {
        console.error(`Request error starting LXC ${fullName}:`, err.message);
        resolve(false);
      });
      
      req.on('timeout', () => {
        console.error(`Request timeout starting LXC ${fullName}`);
        req.destroy();
        resolve(false);
      });
      
      req.end();
    });

    if (!startSuccess) return false;

    // Wait for container to start
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (await isContainerRunning(fullName)) {
        log(`LXC ${fullName} started`);
        return true;
      }
    }
    
    log(`LXC ${fullName} start timeout`);
    return false;

  } catch (error) {
    console.error(`Error in startContainerLXC for ${fullName}:`, error);
    return false;
  }
}


//----------------------------------------------------------------
// Stop Proxmox LXC container
//----------------------------------------------------------------
async function stopContainerLXC(fullName) {
  if (!pveAuthHeader) return false;
  
  const parts = fullName.split(':');
  if (parts.length !== 2) return false;
  
  const vmidNodePart = parts[1];
  const vmidNodeParts = vmidNodePart.split('@');
  if (vmidNodeParts.length !== 2) return false;
  
  const vmid = vmidNodeParts[0];
  if (!vmid || isNaN(parseInt(vmid))) return false;

  try {
    // Send shutdown command
    const shutdownSuccess = await new Promise((resolve) => {
      const req = https.request({
        hostname: pveHostname,
        port: pvePort,
        path: `/api2/json/nodes/${pveNode}/lxc/${vmid}/status/shutdown`,
        method: 'POST',
        headers: { 'Authorization': pveAuthHeader },
        rejectUnauthorized: false,
        timeout: 10000
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode === 200) {
              log(`Shutdown command sent for LXC ${fullName}. Response:`, json);
              resolve(true);
            } else {
              console.error(`Failed to shutdown LXC ${fullName}. API Error:`, json);
              resolve(false);
            }
          } catch (parseError) {
            console.error(`Failed to parse Proxmox API response for ${fullName}:`, parseError);
            resolve(false);
          }
        });
      });
      
      req.on('error', (err) => {
        console.error(`Request error stopping LXC ${fullName}:`, err.message);
        resolve(false);
      });
      
      req.on('timeout', () => {
        console.error(`Request timeout stopping LXC ${fullName}`);
        req.destroy();
        resolve(false);
      });
      
      req.end();
    });

    if (!shutdownSuccess) return false;

    // Wait for container to stop
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (!(await isContainerRunning(fullName))) {
        return true;
      }
    }
    
    log(`LXC ${fullName} shutdown timeout`);
    return false;

  } catch (error) {
    console.error(`Error in stopContainerLXC for ${fullName}:`, error);
    return false;
  }
}


//----------------------------------------------------------------------------------------------------------------------------------
//----------------------------------------------------------------------------------------------------------------------------------
// Combined Functions for Docker + Proxmox LXC
//----------------------------------------------------------------------------------------------------------------------------------
//----------------------------------------------------------------------------------------------------------------------------------

//----------------------------------------------------------------
// Determine container start time in order to prevent stopping earlier if container was started manually for both Docker and LXC
//----------------------------------------------------------------
async function checkStartTime(name, idleTimeout){
  // Check if LXC container (has vmid in name)
  if (name.includes(':') && name.includes('@')) {
    const result = await checkStartTimeLXC(name, idleTimeout);
    return result;
  }
  // Docker container
  return checkStartTimeDocker(name, idleTimeout);
}


//----------------------------------------------------------------
// Get all containers (Docker + Proxmox LXC)
//----------------------------------------------------------------
async function allContainers() {
  const results = new Set();
  
  // Get Docker containers
  const dockerContainers = await allContainersDocker();
  dockerContainers.forEach(c => results.add(c));
  
  // Get LXC containers if configured
  if (pveAuthHeader) {
    const lxcContainers = await allContainersLXC();
    lxcContainers.forEach(c => results.add(c));
  }

  return Array.from(results);
}


//----------------------------------------------------------------
// Check if container is running (Docker + Proxmox LXC)
//----------------------------------------------------------------
async function isContainerRunning(name) {
  // Check if LXC container (has vmid in name)
  if (name.includes(':') && name.includes('@')) {
    const result = await isContainerRunningLXC(name);
    return result;
  }
  // Docker container
  return isContainerRunningDocker(name);
}


//----------------------------------------------------------------
// Start container (Docker + Proxmox LXC)
//----------------------------------------------------------------
async function startContainer(name) {
  // Check if LXC container (has vmid in name)
  if (name.includes(':') && name.includes('@')) {
    return startContainerLXC(name);
  }
  // Docker container
  return startContainerDocker(name);
}


//----------------------------------------------------------------
// Stop container (Docker + Proxmox LXC)
//----------------------------------------------------------------
async function stopContainer(name) {
  // Check if LXC container (has vmid in name)
  if (name.includes(':') && name.includes('@')) {
    return stopContainerLXC(name);
  }
  // Docker container
  return stopContainerDocker(name);
}


//----------------------------------------------------------------
// Expose control functions for backend and UI
//----------------------------------------------------------------
app.use("/api/containers", express.json(), containerRoutes);
app.use("/api/groups", express.json(), groupRoutes);
app.use("/api/schedules", express.json(), scheduleRoutes);

app.locals.startContainer = startContainer;
app.locals.stopContainer = stopContainer;
app.locals.isContainerRunning = isContainerRunning;
app.locals.lastActivity = lastActivity;


//----------------------------------------------------------------
// Web UI server
//----------------------------------------------------------------
const UI_PORT = process.env.UI_PORT || null;

const ui = express();
ui.use(express.json());                     // keep JSON parsing
ui.use("/api/containers", containerRoutes); // container API routes
ui.use(express.static("/app/public/ui"));  // serve HTML/CSS/JS
ui.use("/api/groups", groupRoutes); // group API routes
ui.use("/api/schedules", scheduleRoutes); // schedule API routes

// Expose container control utilities to UI routes

ui.locals.isContainerRunning = isContainerRunning;
ui.locals.startContainer = startContainer;
ui.locals.stopContainer = stopContainer;
ui.locals.lastActivity = lastActivity;
ui.locals.allContainers = allContainers;

// Start UI server if defined
if (UI_PORT){ 
  ui.listen(UI_PORT, () => {
    log(`WebUI running on port ${UI_PORT}`);
  });
}


//----------------------------------------------------------------
// Main proxy middleware
//----------------------------------------------------------------
app.use(async (req, res, next) => {
  const container = containers.find(c => c.host === req.hostname);
  
  if (!container) return res.status(404).send("Container not found");

  // Update the timestamp when the container was last accessed via web requests
  lastActivity[container.name] = Date.now(); 

  // Helper: find active group containing this container
  const group = groups.find(g =>
    g.active &&
    g.container &&
    (Array.isArray(g.container)
      ? g.container.includes(container.name)
      : g.container === container.name)
  );

  // If the container is running, redirect to it's webpage, else start the container
  if (await isContainerRunning(container.name)) {  // ← ADDED AWAIT
    return proxy.web(req, res, { target: container.url, secure: false, changeOrigin: false });
  }

  res.sendFile(waitingPage);

  // Not running — must start it (or its group)
  if (container.active) {
    if (group) {
      // Start every container in the group
      const names = Array.isArray(group.container)
        ? group.container
        : [group.container];

      // Changed forEach to for...of to use await
      for (const name of names) { 

        // Check if this specific container in the group is active
        const containerInGroup = containers.find(c => c.name === name);
        if (!containerInGroup || !containerInGroup.active) {
          log(`<${name}> in group <${group.name}> is not active, skipping`);
          continue;
        }

        if (!(await isContainerRunning(name))) {  
          await startContainer(name);
        }
      }

      log(`<${container.name}> was accessed, starting group <${group.name}>`);
    } else {
      // Start single container normally
      await startContainer(container.name); 
    }
  }
});
  /*
  let r;

  // If the service endpoint is reachable, serve the webpage; else serve the waiting page until ready
  try {
    if (container.name.includes(':') && container.name.includes('@')) {
      r = await fetch(`${container.url}/`, { method: "GET" });
    } else {
      r = await fetch(`${container.url}/health`, { method: "GET" });
    }
    if (r.ok) {
      // healthy → proxy
      return proxy.web(req, res, { target: container.url, secure: false, changeOrigin: false });
    } else if (r.status === 502) {
      // 502 → container not ready, serve waiting page
      return res.sendFile(waitingPage);
    }
  } catch (e) {
    // fetch failed → container not ready
    return res.sendFile(waitingPage);
  }

  res.sendFile(waitingPage);
}); */
      


//----------------------------------------------------------------
// Tracking the webrequest timeout
//----------------------------------------------------------------
const lastLog = {}; // track last log time per container
proxy.on('proxyRes', (proxyRes, req) => {
  const container = containers.find(c => c.host === req.hostname);
  if (!container) return;

  lastActivity[container.name] = Date.now();

  const now = Date.now();
  if (!lastLog[container.name] || now - lastLog[container.name] > 5000) { // 5000 ms = 5 sec
    log(`<${container.name}> accessed on ${new Date(lastActivity[container.name]).toISOString()}, timeout reset`);
    lastLog[container.name] = now;
  }
});


//----------------------------------------------------------------
// Timeout handling
//----------------------------------------------------------------
setInterval(async () => {
  try {
    const now = Date.now();
    
    // Batch check all containers at once
    const containerStatus = await checkMultipleContainers(
      containers.map(c => c.name)
    );
    
    // ─────────────────────────────────────────────
    // INDIVIDUAL CONTAINER TIMEOUT (non-group)
    // ─────────────────────────────────────────────
    for (const c of containers) {
      if (!c.active || !c.idleTimeout || isContainerInGroup(c.name, groups)) {
        continue;
      }
      
      const isRunning = containerStatus[c.name];
      const timeoutReached = now - lastActivity[c.name] > (c.idleTimeout || 60) * 1000;
      
      if (isRunning && timeoutReached && 
          checkStartTime(c.name, c.idleTimeout) &&
          checkActivationTime(c.name, c.idleTimeout) &&
          !stoppingContainers.has(c.name)) {
        
        log(`<${c.name}> ${(c.idleTimeout || 60)} seconds timeout reached`);
        stoppingContainers.add(c.name);
        await stopContainer(c.name);
        log(`<${c.name}> stopped successfully`);
        stoppingContainers.delete(c.name);
        logOnce = true;
      }
    }
    
    // ─────────────────────────────────────────────
    // GROUP TIMEOUT
    // ─────────────────────────────────────────────
    for (const g of groups) {
      if (!g.active || !g.idleTimeout || !g.container) continue;

      const groupContainers = Array.isArray(g.container)
        ? g.container
        : [g.container];

      // Check if ANY container in group exceeds timeout
      const shouldStopGroup = groupContainers.every(name => {
        const isRunning = containerStatus[name];
        const container = containers.find(c => c.name === name);
        return (
          isRunning &&
          container &&
          container.active &&
          now - lastActivity[name] > (g.idleTimeout || 60) * 1000 &&
          checkStartTime(name, g.idleTimeout)
        );
      });

      if (shouldStopGroup) {
        for (const name of groupContainers) {
          const container = containers.find(c => c.name === name);
          if (containerStatus[name] && container && container.active && !stoppingContainers.has(name)) {
            stoppingContainers.add(c.name);
            await stopContainer(name);
            stoppingContainers.delete(c.name);
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
// Schedule handling
//----------------------------------------------------------------
setInterval(() => {
  const now = new Date();
  const day = now.getDay();  
  const time = now.toTimeString().slice(0,5);

  schedules.forEach(s => {

    const target = s.targetType === "container"
      ? containers.find(c => c.name === s.target)
      : groups.find(g => g.name === s.target);

    if (!target || !target.active) return;

    if (!s.timers || s.timers.length === 0) return;

    s.timers.forEach(timer => {
      if (!timer.active) return;

      const dayMatch = timer.days.includes(day);
      const startMatch = timer.startTime === time;
      const stopMatch = timer.stopTime === time;

      if (!dayMatch) return;

      if (startMatch) {
        if (s.targetType === "container") startContainer(s.target);
        else target.container.forEach(n => startContainer(n));

        log(`<${s.target}> scheduled start executed`);
      }

      if (stopMatch && !stoppingContainers.has(s.target)) {
        stoppingContainers.add(s.target);
        if (s.targetType === "container") stopContainer(s.target);
        else target.container.forEach(n => stopContainer(n));
        stoppingContainers.delete(s.target);
        log(`<${s.target}> scheduled stop executed`);
      }
    });
  });
}, 59000);


//----------------------------------------------------------------
// Reload configuration function
//----------------------------------------------------------------
function reloadConfig() {
  try {
    const newConfig = JSON.parse(fs.readFileSync("/app/config/config.json"));
    
    // Merge lastActivity for existing containers
    newConfig.containers.forEach(c => {
      if (lastActivity[c.name] === undefined) {
        lastActivity[c.name] = Date.now();
      }
    });

    groups = newConfig.groups;
    containers = newConfig.containers;
    schedules = newConfig.schedules;
    apiKeys = newConfig.apiKeys;
    log("Config reloaded, containers updated");
  } catch (e) {
    log(`Failed to reload config: ${e.message}`);
  }
}


//----------------------------------------------------------------
// Reload configuration if config.json has been changed
//----------------------------------------------------------------
fs.watchFile("/app/config/config.json", { interval: 500 }, () => {
  reloadConfig();
});


//----------------------------------------------------------------
// Main app, starts the app listening on the defined port
//----------------------------------------------------------------
const server = app.listen(PORT, () => {
  log(`Spinnerr Proxy running on port ${PORT}`);
});

server.on("upgrade", (req, socket, head) => {
  const container = containers.find(c => c.host === req.headers.host);
  if (!container) return socket.destroy();
  proxy.ws(req, socket, head, { target: container.url, ws: true, changeOrigin: false, xfwd: true });
});