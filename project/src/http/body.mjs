/**
 * Bounded request-body reading.
 *
 * The body is always read to completion before a response is produced (even for
 * a request that will be rejected), because answering while the peer is still
 * writing turns an honestly rejected request into a connection reset. Once the
 * declared limit is exceeded, accumulation stops — the rest is drained and
 * discarded, so an oversized body costs a bounded amount of memory.
 */

export function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    let settled = false

    const finish = () => {
      if (settled) return
      settled = true
      resolve({ tooLarge, buffer: tooLarge ? Buffer.alloc(0) : Buffer.concat(chunks) })
    }

    req.on('data', (chunk) => {
      if (settled) return
      if (tooLarge) return
      size += chunk.length
      if (size > maxBytes) {
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', finish)
    req.on('close', finish)
    req.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}
