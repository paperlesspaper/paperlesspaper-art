const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

export function isLocalDevelopmentRequest(request: Request) {
  if (process.env.NODE_ENV !== "development") return false;

  const requestHost = request.headers.get("host") ?? new URL(request.url).host;
  return isLocalHostname(requestHost);
}

export function isLocalDevelopmentHeaders(headers: Headers) {
  if (process.env.NODE_ENV !== "development") return false;

  const requestHost = headers.get("host");
  return requestHost ? isLocalHostname(requestHost) : false;
}

function isLocalHostname(host: string) {
  const hostname = parseHostname(host);
  return hostname
    ? LOCAL_HOSTNAMES.has(hostname) || isPrivateNetworkHostname(hostname)
    : false;
}

function isPrivateNetworkHostname(hostname: string) {
  if (hostname.endsWith(".local")) return true;

  const octets = hostname.split(".").map((part) => Number(part));
  if (octets.length === 4 && octets.every((octet) => Number.isInteger(octet))) {
    const [first, second] = octets;

    return (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    );
  }

  return (
    hostname.startsWith("fc") ||
    hostname.startsWith("fd") ||
    hostname.startsWith("fe80:")
  );
}

function parseHostname(host: string) {
  const normalized = host.trim();
  if (!normalized) return undefined;

  try {
    return stripIpv6Brackets(new URL(`http://${normalized}`).hostname);
  } catch {
    return stripIpv6Brackets(normalized.split(":")[0] ?? "").toLowerCase();
  }
}

function stripIpv6Brackets(value: string) {
  return value.toLowerCase().replace(/^\[(.*)\]$/, "$1");
}
