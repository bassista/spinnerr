import { exec } from "child_process";
import fs from "fs";

//----------------------------------------------------------------
// Configuration
//----------------------------------------------------------------
const DOCKER_PROXY_URL = process.env.DOCKER_PROXY_URL || null;
const HAS_SOCKET = fs.existsSync("/var/run/docker.sock");

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
// Docker connection method
//----------------------------------------------------------------
let dockerMethod = "none";

export function initializeDockerMethod() {
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
  return dockerMethod;
}

export function getDockerMethod() {
  return dockerMethod;
}

//----------------------------------------------------------------
// Docker Functions
//----------------------------------------------------------------
async function executeDockerCommand(command) {
  return new Promise((resolve) => {
    exec(command, { timeout: 3000 }, (error, stdout, stderr) => {
      resolve({ error, stdout: stdout?.toString().trim(), stderr });
    });
  });
}

export async function isContainerRunning(name) {
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

export async function allContainers() {
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

export async function startContainer(name) {
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

export async function stopContainer(name) {
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
