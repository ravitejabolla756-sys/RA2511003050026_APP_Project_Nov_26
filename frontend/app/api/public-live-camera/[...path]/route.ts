const UPSTREAM_BASE = new URL("https://video2.iowadot.gov:8888/councilbluffs/cbtv74lb/");
const LOCAL_PREFIX = "/api/public-live-camera/";
const ALLOWED_FILE = /^(?:playlist|stream)\.m3u8$|^[A-Za-z0-9_-]{1,100}\.mp4$/;

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ path: string[] }> };

function localReference(reference: string, requestUrl: URL): string | null {
  let resolved: URL;
  try {
    resolved = new URL(reference, UPSTREAM_BASE);
  } catch {
    return null;
  }

  if (resolved.origin !== UPSTREAM_BASE.origin || !resolved.pathname.startsWith(UPSTREAM_BASE.pathname)) return null;
  const filename = decodeURIComponent(resolved.pathname.slice(UPSTREAM_BASE.pathname.length));
  if (!ALLOWED_FILE.test(filename)) return null;
  return new URL(`${LOCAL_PREFIX}${encodeURIComponent(filename)}`, requestUrl).toString();
}

function responseHeaders(contentType: string) {
  return {
    "Cache-Control": "no-store",
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
  };
}

export async function GET(request: Request, context: RouteContext) {
  const { path } = await context.params;
  if (path.length !== 1 || !ALLOWED_FILE.test(path[0])) {
    return Response.json({ error: "Unknown public camera resource." }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  const filename = path[0];
  const range = request.headers.get("range");
  if (range && !/^bytes=\d*-\d*$/.test(range)) {
    return Response.json({ error: "Invalid media range." }, { status: 416, headers: { "Cache-Control": "no-store" } });
  }

  try {
    const upstream = await fetch(new URL(filename, UPSTREAM_BASE), {
      cache: "no-store",
      headers: range ? { Range: range } : undefined,
      signal: AbortSignal.timeout(20_000),
    });

    if (!upstream.ok || !upstream.body) {
      return Response.json({ error: "The Iowa DOT camera resource is unavailable." }, { status: upstream.status || 502, headers: { "Cache-Control": "no-store" } });
    }

    const contentType = filename.endsWith(".m3u8")
      ? "application/vnd.apple.mpegurl"
      : upstream.headers.get("content-type") || "video/mp4";

    if (filename.endsWith(".m3u8")) {
      const manifest = await upstream.text();
      const rewrittenLines: string[] = [];
      for (const line of manifest.split(/\r?\n/)) {
        if (line.startsWith("#")) {
          let invalidReference = false;
          const rewritten = line.replace(/URI="([^"]+)"/g, (_, uri: string) => {
            const local = localReference(uri, new URL(request.url));
            if (!local) invalidReference = true;
            return `URI="${local ?? ""}"`;
          });
          if (invalidReference) return Response.json({ error: "The camera playlist contains an unsupported resource." }, { status: 502, headers: { "Cache-Control": "no-store" } });
          rewrittenLines.push(rewritten);
        } else if (line.trim()) {
          const local = localReference(line.trim(), new URL(request.url));
          if (!local) return Response.json({ error: "The camera playlist contains an unsupported resource." }, { status: 502, headers: { "Cache-Control": "no-store" } });
          rewrittenLines.push(local);
        } else {
          rewrittenLines.push(line);
        }
      }
      return new Response(rewrittenLines.join("\n"), { headers: responseHeaders(contentType) });
    }

    const headers = new Headers(responseHeaders(contentType));
    const contentRange = upstream.headers.get("content-range");
    if (contentRange) headers.set("Content-Range", contentRange);
    const contentLength = upstream.headers.get("content-length");
    if (contentLength) headers.set("Content-Length", contentLength);
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch {
    return Response.json({ error: "Could not reach the Iowa DOT camera stream." }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
