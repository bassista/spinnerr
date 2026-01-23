
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
    const { findContainerByRequest } = await import('./requestHandler.js');
    
    const container = findContainerByRequest(req, containers);
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

    // If container is running, send waiting page
    if (await isContainerRunning(container.name)) {
      log(`<${container.name}> is running, send waiting page for container at ${redirectUrl}`);
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
  };
}
