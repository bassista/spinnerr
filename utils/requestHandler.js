
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
// Container Lookup
//----------------------------------------------------------------
export function findContainerByRequest(req, containers, preferHeader = false) {
  let hostname = preferHeader ? req.headers.host : (req.hostname || req.headers.host);
  
  // First try to find by hostname
  let container = containers.find(c => c.host === hostname);
  if (container) return container;
  
  // If not found, try to find by path
  let pathSegments = req.path?.split('/').filter(Boolean);
  if (pathSegments && pathSegments.length > 0) {
    let firstPathSegment = pathSegments[0];
    container = containers.find(c => c.path === firstPathSegment);
    if (container) {
      log(`<${container.name}> accessed via path prefix /${firstPathSegment}`);
      return container;
    }
  }
  log(`No container found for hostname: ${hostname}, path: ${req.path} - preferHeader: ${preferHeader}`);

  return null;
}
