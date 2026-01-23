
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
// Schedule handler setup
//----------------------------------------------------------------
export function initializeScheduler(getSchedules, getContainers, getGroups, startContainer, stopContainer, stoppingContainers) {
  setInterval(async () => {
    const schedules = getSchedules();
    const containers = getContainers();
    const groups = getGroups();
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
}
