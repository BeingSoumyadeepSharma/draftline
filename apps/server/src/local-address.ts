/**
 * Inside a Docker container, "localhost" is the container itself, not the
 * computer running it. So when LOCALHOST_ALIAS is set (the Docker setup sets it
 * to host.docker.internal), addresses on localhost, such as an Ollama model
 * saved as http://localhost:11434/v1, are sent to the computer instead.
 * Saved settings stay the same, so they work both in and out of Docker.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function reachableUrl(address: string, alias = process.env.LOCALHOST_ALIAS): string {
  if (!alias) return address;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return address;
  }
  if (!LOCAL_HOSTS.has(url.hostname)) return address;
  url.hostname = alias;
  // URL adds a trailing slash to a bare origin; keep the address as it was.
  return address.endsWith("/") ? url.toString() : url.toString().replace(/\/$/, "");
}
