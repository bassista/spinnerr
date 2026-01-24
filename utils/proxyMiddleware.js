
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
// Proxy Middleware
//----------------------------------------------------------------
export function createProxyMiddleware(containers, groups, lastActivity, recentlyStarted, cachedWaitingPageContent, isContainerRunning, startContainer) {
  return async (req, res, next) => {
 
    let group
    let container = findContainerByRequest(req, containers);
    if (!container) {
        const pathName = pathNameFrom(req);
        if (pathName) {
            // Find active group with given name
            group = groups.find(g => g.active && g.name === pathName);

            if (group && group.container) {
                log(`Group <${group.name}> found`);
                const containerNames = Array.isArray(group.container) ? group.container : [group.container];
                
                // Find first active container with host and path configured
                for (const name of containerNames) {
                    const c = containers.find(c => c.name === name);
                    if (c?.active && c?.host && c?.path) {
                        container = c;
                        log(`Selected container <${c.name}> from group <${group.name}>`);
                        break;
                    }
                }
                
                if (!container) {
                    log(`No valid container found in group <${group.name}>`);
                }
            }    
        }
    }

    if (!container) {
      log(`No container matched for request: ${req.hostname || req.headers.host}${req.path}`);
      return res.status(404).send("Container not found");
    }

    if (!container.path || !container.host) {
        log(`<${container.name}> missing path or host configuration`);
        return res.status(500).send("Container misconfigured");
    }

    if (container.active === false) 
        return res.status(403).send("Container is disabled");

    log(`<${container.name}> accessed`);
    lastActivity[container.name] = Date.now();

    let redirectUrl = `https://${container.path}.${container.host}`;
    const waitingPageContent = cachedWaitingPageContent
                                 .replace('{{REDIRECT_URL}}', redirectUrl)
                                 .replace('{{CONTAINER_NAME}}', container.name);

    res.type('text/html').send(waitingPageContent);
                                 
    if (group) {
        await startContainersInGroup(group, containers, isContainerRunning, startContainer);
        return;
    }

    // If container is running, send waiting page
    if (await isContainerRunning(container.name)) {
      log(`<${container.name}> is running, send waiting page for container at ${redirectUrl}`);
      return;    
    }

    if (recentlyStarted.has(container.name)) {
      log(`<${container.name}> was started recently, not starting again`);
      return;
    }

    let timeoutId = setTimeout(() => recentlyStarted.delete(container.name), 30000);
    recentlyStarted.set(container.name, { startedAt: Date.now(), timeoutId });
    log(`<${container.name}> is not running, starting it now`);
    await startContainer(container.name);
  };
}

async function startContainersInGroup(group, containers, isContainerRunning, startContainer) {
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
}

//----------------------------------------------------------------
// Container Lookup
//----------------------------------------------------------------
function findContainerByRequest(req, containers) {
  let firstPathSegment = pathNameFrom(req);
  if (firstPathSegment) {
      let container = containers.find(c => c.path === firstPathSegment);
      if (container) {
          log(`<${container.name}> accessed via path prefix /${firstPathSegment}`);
          return container;
      }
  }

  log(`No container found for path: ${req.path}`);
  return null;
}

function pathNameFrom(req) {
  let pathSegments = req.path?.split('/').filter(Boolean);

  if (pathSegments && pathSegments.length > 0) 
      return pathSegments[0];
  return null;
}