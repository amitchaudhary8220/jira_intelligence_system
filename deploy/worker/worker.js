// A fixed, named address for the app shared from the Mac: https://jira-pulse.<subdomain>.workers.dev
//
// The Mac's Cloudflare quick tunnel gets a random https://<words>.trycloudflare.com link that changes when the
// tunnel restarts. This Worker forwards every request to that link (TARGET, set by `make share` on deploy),
// so people and Google's redirect URI only ever see the workers.dev address.
// Login is NOT done here: oauth2-proxy behind the tunnel asks for Google sign-in. This Worker only forwards.

export default {
  async fetch(request, env) {
    if (!env.TARGET) return new Response("Jira Pulse is not being shared right now.", { status: 503 })
    const url = new URL(request.url)
    const target = new URL(env.TARGET)
    const upstream = new URL(url.pathname + url.search, target)

    const headers = new Headers(request.headers)
    headers.delete("host")
    headers.set("X-Forwarded-Host", url.host)         // oauth2-proxy builds its redirects from these
    headers.set("X-Forwarded-Proto", "https")

    let response
    try {
      response = await fetch(upstream, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual",                             // let the browser follow redirects (Google sign-in)
      })
    } catch {
      return new Response("Jira Pulse is not reachable right now (the sharing Mac may be asleep).", { status: 502 })
    }

    const out = new Response(response.body, response)  // streams through (chat answers arrive word by word)
    const location = out.headers.get("Location")
    if (location && location.startsWith(target.origin)) {
      out.headers.set("Location", url.origin + location.slice(target.origin.length))
    }
    return out
  },
}
