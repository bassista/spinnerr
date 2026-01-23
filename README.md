<p align="center">
  <img width="300" height="300" alt="logo" src="https://github.com/user-attachments/assets/b648eb5d-c621-42ef-8289-382f0db171a0" />
</p>
    
Spinnerr is a lightweight Node.js-based service that automatically starts Docker containers when accessed through a defined web route either individually or as part of a group.

Kudos to drgshub @https://github.com/drgshub/spinnerr for the original project and idea.

## Features

* Automatic container management: Containers start on demand when a user accesses their web route.
* Configurable via web UI: Optional UI to add, edit, or remove container entries 
* Container groups: containers can be grouped to be started and stopped together.
* Lightweight and efficient: Minimal overhead, runs as a Docker container itself.
* Scheduler for containers: Automate start/stop of containers or groups based on time and day.
  
## Installation

The package can be pulled directly from GitHub with Docker pull or Docker Compose.

##### Pull the repository
```
docker pull bassista/spinnerr:latest
```
### Docker run
```
docker run -d \
  --name spinnerr \
  --restart unless-stopped \
  -p 10000:10000 \
  -p 11000:11000 \
  --network spinnerr \
  --network proxynetwork \
  -e PORT=10000 \
  -e UI_PORT=11000 \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v /path/to/spinnerr/config:/app/config \
  bassista/spinnerr:latest
```
### Docker Compose
```
version: "3.9"

services:
  spinnerr:
    image: bassista/spinnerr:latest
    container_name: spinnerr
    ports:
      - "10000:10000"
      - "11000:11000"
    restart: unless-stopped
    networks:
      - spinnerr
    environment:
      - PORT=10000
      - UI_PORT=11000
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /path/to/spinnerr/config:/app/config

networks:
  spinnerr:
    external: true
```


## Usage

The tool can be configured to run both with a docker socket proxy, with the socket mounted or the host network mode.

>#### 1. Using a Socket Proxy
>
>a. Single Network Setup
>When using a socket proxy with only Spinnerr and the Docker Socket Proxy in a single network, you must use the Docker hostname and the external port.
>
>b. Multi-Container Network Setup
>When using a socket proxy with all managed containers, along with Spinnerr and the Docker Socket Proxy in the same network, you can connect using either:
>	•	The Docker hostname and external port, or
>	•	The internal container name and internal port.
>
>#### 2. Socket Mounted Directly on Spinnerr
>
>If the Docker socket is mounted directly on Spinnerr, you can use either of the above configurations, without the need for a Docker Socket Proxy.
>
>#### 3. Network Mode: host
>
>When using host network mode, only the external address and external IP are supported for connecting.

If you'd like to use the tool with the docker socket proxy make sure you add the enviorment variable DOCKER_PROXY_URL pointing to your proxy container (e.g. tcp://docker-socket-proxy:2375) and to maintain the container is the same network as the proxy.

Configuration can be changed from the WebUI, which can be accessed as http://localhost:<UI_PORT>, or can be edited manually in the config.json file. No container restart is needed in either cases.

Although the tool supports basic HTTP reverse proxying, it’s generally better to rely on a dedicated reverse proxy like NGINX. If you decide to use NGINX, ensure it redirects traffic to the container’s appropriate listening port. For example:

```
{
  "containers": [
    {
      "name": "flame", <--------- name of the container in the docker network
      "url": "http://flame:5005", <----- web access of the container in the docker network
      "idleTimeout": 180000,  <-------- timeout after no webrequests have been received, 0 will disable stopping the container after timeout
      "host": "flame.mydomain.com" <------- domain used to access the service
      rest of the configuration...
    }
  ...
}
```

For the above example, Nginx needs to point to <host-ip>:<PORT>, where PORT is defined in the environment variables.

## Groups

Containers added in Spinnerr can be grouped up in order to be stopped and started together. As long as the group is active, the timeout will override the individual container timeout. Same as containers, the idle timeout can be set to 0 in order to prevent stopping the containers after the timeout is reached (this value still overides the individual container timeout). If a container from the group is disabled, group actions will not have any impact on it. 

If you need to create a group consiting of a main web application + database container or other reference container which doesn't require web access, you can set a dummy value for the reference container's internal and external host - this way the reference containers will not be started and stopped based on web requests, only as part of the group of which they are part of.

<img width="529" height="706" alt="image" src="https://github.com/user-attachments/assets/c7a690bb-d587-453f-b180-097d24afefaf" />


## Scheduler

You can schedule containers and groups to start and stop based on time and weekdays. Multiple rules can be created to run in parallel.

Do note that:
* The container/group needs to be active in order for the scheduler to work
* The timeout of the container/group overides the schedule, so if the idle timeout should stop the container before reaching the scheduled stop, it will
* In order to prevent this behaviour, you can set the timeout of the container/group to 0
* You can edit, disable or delete any of the created schedules

<img width="507" height="903" alt="image" src="https://github.com/user-attachments/assets/1071afcb-74dd-4bdf-829e-f2580789c4cc" />


## Web UI

### Dashboard

<img width="2559" height="1119" alt="image" src="https://github.com/user-attachments/assets/0064e99f-83cf-435d-8d29-07117144338c" />

<img width="2554" height="1215" alt="image" src="https://github.com/user-attachments/assets/a4179771-85a4-4cd6-a619-74f795ad9c36" />


## Variables

Variable | Usage 
--- | ---
PORT | Port of the reverse proxy
UI_PORT | Port of the Web UI
DOCKER_PROXY_URL | Address of the socket proxy, must start with tcp://


## License

Spinnerr is licensed under the [Apache License 2.0](./LICENSE).  
See the LICENSE file for details.

----------


