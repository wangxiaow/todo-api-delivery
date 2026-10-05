/**
 * Minimal path router.
 *
 * It answers two questions the error model needs: is there a route for this
 * path at all (otherwise 404), and if so which methods does it allow (otherwise
 * 405 with an `Allow` header).
 */

function matchPattern(pattern, pathname) {
  const wanted = pattern.split('/')
  const actual = pathname.split('/')
  if (wanted.length !== actual.length) return null
  const params = {}
  for (let index = 0; index < wanted.length; index += 1) {
    const segment = wanted[index]
    if (segment.startsWith(':')) {
      if (actual[index] === '') return null
      params[segment.slice(1)] = decodeURIComponent(actual[index])
      continue
    }
    if (segment !== actual[index]) return null
  }
  return params
}

export function createRouter(routes) {
  return function route(method, pathname) {
    const allowed = new Set()
    let pathMatched = false
    for (const candidate of routes) {
      const params = matchPattern(candidate.pattern, pathname)
      if (!params) continue
      pathMatched = true
      if (candidate.method === method) return { route: candidate, params }
      allowed.add(candidate.method)
    }
    if (!pathMatched) return null
    allowed.add('OPTIONS')
    return { methodNotAllowed: [...allowed].sort() }
  }
}
