import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 4;

export class SafeHttpError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SafeHttpError";
    this.code = code;
  }
}

function ipv4Number(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function inV4Range(value, base, prefix) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

function publicIpv4(address) {
  const value = ipv4Number(address);
  if (value == null) return false;
  const blocked = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  return !blocked.some(([base, prefix]) => inV4Range(value, ipv4Number(base), prefix));
}

function normalizedIpv6(address) {
  const value = String(address || "").toLowerCase().split("%")[0];
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

const nonPublicIpv6 = new BlockList();
for (const [base, prefix] of [
  ["::", 96], // unspecified, loopback and deprecated IPv4-compatible addresses
  ["::ffff:0:0", 96], // IPv4-mapped addresses, including hexadecimal loopback forms
  ["64:ff9b::", 96], // well-known NAT64 translation prefix
  ["64:ff9b:1::", 48], // local-use NAT64 translation prefix
  ["100::", 64], // discard-only
  ["2001::", 32], // Teredo transition addresses
  ["2001:2::", 48], // benchmarking
  ["2001:10::", 28], // deprecated ORCHID
  ["2001:20::", 28], // ORCHIDv2
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 embeds an IPv4 destination
  ["3fff::", 20], // documentation
  ["fc00::", 7], // unique-local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // deprecated site-local
  ["ff00::", 8], // multicast
]) {
  nonPublicIpv6.addSubnet(base, prefix, "ipv6");
}

function publicIpv6(address) {
  const value = normalizedIpv6(address);
  return isIP(value) === 6 && !nonPublicIpv6.check(value, "ipv6");
}

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return publicIpv4(address);
  if (family === 6) return publicIpv6(address);
  return false;
}

export function parsePublicHttpUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new SafeHttpError("bad_url", "Некорректный URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeHttpError("bad_protocol", "Разрешены только HTTP и HTTPS");
  }
  if (url.username || url.password) {
    throw new SafeHttpError("credentials", "URL с логином или паролем запрещён");
  }
  if (!url.hostname) throw new SafeHttpError("bad_host", "В URL нет хоста");
  return url;
}

export async function resolvePublicTarget(url, lookupFn = dnsLookup) {
  const hostname = normalizedIpv6(url.hostname);
  const literalFamily = isIP(hostname);
  const records = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookupFn(hostname, { all: true, verbatim: true });
  if (!records.length || records.some((record) => !isPublicAddress(record.address))) {
    throw new SafeHttpError("private_address", "Адрес ведёт во внутреннюю или служебную сеть");
  }
  return records[0];
}

export function validatePublicRedirect(value, fromUrl, validateRedirect) {
  const nextUrl = parsePublicHttpUrl(value);
  if (validateRedirect && validateRedirect(nextUrl, fromUrl) === false) {
    throw new SafeHttpError("redirect_forbidden", "Перенаправление ведёт за разрешённые границы");
  }
  return nextUrl;
}

async function withinDeadline(work, timeoutMs) {
  let deadline;
  try {
    return await Promise.race([
      work,
      new Promise((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new SafeHttpError("timeout", "Сервер не ответил вовремя")),
          timeoutMs,
        );
        deadline.unref?.();
      }),
    ]);
  } finally {
    if (deadline) clearTimeout(deadline);
  }
}

function requestOnce(url, target, { timeoutMs, maxBytes, headers, requestFn }) {
  const transport = url.protocol === "https:" ? https : http;
  const hostname = normalizedIpv6(url.hostname);
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline;
    let receivedBytes = 0;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      fn(value);
    };
    const fail = (error) => {
      if (error && typeof error === "object" && !Number.isFinite(Number(error.byteLength))) {
        try {
          error.byteLength = receivedBytes;
        } catch {
          // The public error code still remains safe when a foreign error is immutable.
        }
      }
      finish(reject, error);
    };
    const req = (requestFn || transport.request.bind(transport))(
      {
        protocol: url.protocol,
        hostname: target.address,
        family: target.family,
        port: url.port || undefined,
        method: "GET",
        path: `${url.pathname}${url.search}`,
        servername: isIP(hostname) ? undefined : hostname,
        agent: false,
        headers: {
          ...headers,
          host: url.host,
          "accept-encoding": "identity",
        },
      },
      (res) => {
        const status = Number(res.statusCode || 0);
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          // The redirect body is irrelevant and must not outlive the bounded request.
          res.destroy();
          finish(resolve, { redirect: new URL(location, url), status });
          return;
        }

        const declared = Number(res.headers["content-length"] || 0);
        if (declared > maxBytes) {
          res.destroy();
          finish(reject, new SafeHttpError("too_large", "Ответ превышает допустимый размер"));
          return;
        }

        const chunks = [];
        res.on("data", (chunk) => {
          receivedBytes += chunk.length;
          if (receivedBytes > maxBytes) {
            res.destroy(new SafeHttpError("too_large", "Ответ превышает допустимый размер"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          finish(resolve, {
            status,
            ok: status >= 200 && status < 300,
            headers: res.headers,
            body,
          });
        });
        res.on("error", fail);
      },
    );
    // ClientRequest#setTimeout is an inactivity timeout and a slow peer can reset it by
    // dripping bytes. This timer is an absolute wall-clock deadline for the whole hop.
    deadline = setTimeout(
      () => req.destroy(new SafeHttpError("timeout", "Сервер не ответил вовремя")),
      timeoutMs,
    );
    deadline.unref?.();
    req.setTimeout(timeoutMs, () => req.destroy(new SafeHttpError("timeout", "Сервер не ответил вовремя")));
    req.on("error", fail);
    req.end();
  });
}

/**
 * Загружает небольшой текстовый ресурс только из публичной сети. DNS-ответ закрепляется
 * за конкретным соединением, поэтому повторный DNS lookup между проверкой и connect не
 * может перебросить запрос на loopback/private IP. Каждый redirect проверяется заново.
 */
export async function fetchPublicText(value, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const lookupFn = options.lookupFn ?? dnsLookup;
  let url = parsePublicHttpUrl(value);

  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    const hopStartedAt = Date.now();
    const target = await withinDeadline(resolvePublicTarget(url, lookupFn), timeoutMs);
    const result = await requestOnce(url, target, {
      timeoutMs: Math.max(1, timeoutMs - (Date.now() - hopStartedAt)),
      maxBytes,
      headers: options.headers ?? {},
      requestFn: options.requestFn,
    });
    if (result.redirect) {
      if (redirects === maxRedirects) {
        throw new SafeHttpError("too_many_redirects", "Слишком много перенаправлений");
      }
      url = validatePublicRedirect(result.redirect, url, options.validateRedirect);
      continue;
    }
    return {
      ok: result.ok,
      status: result.status,
      url: url.toString(),
      headers: result.headers,
      byteLength: result.body.byteLength,
      text: async () => result.body.toString("utf8"),
    };
  }
  throw new SafeHttpError("too_many_redirects", "Слишком много перенаправлений");
}

/**
 * Binary counterpart used for provider media. It pins DNS to the checked public address,
 * revalidates every redirect, enforces a byte ceiling, and can require HTTPS end-to-end.
 */
export async function fetchPublicBuffer(value, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const lookupFn = options.lookupFn ?? dnsLookup;
  const httpsOnly = options.httpsOnly === true;
  let url = parsePublicHttpUrl(value);

  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    if (httpsOnly && url.protocol !== "https:") {
      throw new SafeHttpError("bad_protocol", "Для медиа разрешён только HTTPS");
    }
    const hopStartedAt = Date.now();
    const target = await withinDeadline(resolvePublicTarget(url, lookupFn), timeoutMs);
    const result = await requestOnce(url, target, {
      timeoutMs: Math.max(1, timeoutMs - (Date.now() - hopStartedAt)),
      maxBytes,
      headers: options.headers ?? {},
      requestFn: options.requestFn,
    });
    if (result.redirect) {
      if (redirects === maxRedirects) {
        throw new SafeHttpError("too_many_redirects", "Слишком много перенаправлений");
      }
      url = validatePublicRedirect(result.redirect, url, options.validateRedirect);
      continue;
    }
    return {
      ok: result.ok,
      status: result.status,
      url: url.toString(),
      headers: result.headers,
      buffer: result.body,
    };
  }
  throw new SafeHttpError("too_many_redirects", "Слишком много перенаправлений");
}
