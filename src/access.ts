// Optional verification of the Cloudflare Access JWT.
// Access already blocks unauthenticated requests at the edge; this is a second
// check in case the Worker is ever reachable by another route.

interface Jwk extends JsonWebKey {
  kid: string;
}

let cachedKeys: { domain: string; keys: Map<string, CryptoKey>; fetchedAt: number } | null = null;
const KEY_TTL_MS = 60 * 60 * 1000;

function b64urlDecode(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function getKeys(domain: string, force = false): Promise<Map<string, CryptoKey>> {
  if (!force && cachedKeys && cachedKeys.domain === domain && Date.now() - cachedKeys.fetchedAt < KEY_TTL_MS) {
    return cachedKeys.keys;
  }
  const res = await fetch(`https://${domain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Failed to fetch Access certs: ${res.status}`);
  const { keys } = (await res.json()) as { keys: Jwk[] };
  const map = new Map<string, CryptoKey>();
  for (const jwk of keys) {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    map.set(jwk.kid, key);
  }
  cachedKeys = { domain, keys: map, fetchedAt: Date.now() };
  return map;
}

export async function verifyAccessJwt(request: Request, teamDomain: string, aud: string): Promise<boolean> {
  const token =
    request.headers.get("Cf-Access-Jwt-Assertion") ??
    request.headers.get("Cookie")?.match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1];
  if (!token) return false;

  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [h, p, s] = parts;

  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(h)));
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
    if (header.alg !== "RS256") return false;

    let key = (await getKeys(teamDomain)).get(header.kid);
    if (!key) key = (await getKeys(teamDomain, true)).get(header.kid); // keys may have rotated
    if (!key) return false;

    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlDecode(s),
      new TextEncoder().encode(`${h}.${p}`),
    );
    if (!valid) return false;

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== "number" || payload.exp < now) return false;
    if (typeof payload.nbf === "number" && payload.nbf > now + 60) return false;
    if (payload.iss !== `https://${teamDomain}`) return false;
    const auds: string[] = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    return auds.includes(aud);
  } catch {
    return false;
  }
}
