/** Parse the final JSON array from npm output that may include lifecycle logs. */
export function parseTrailingJsonArray(output) {
  const starts = [0]
  for (let index = output.indexOf('\n['); index >= 0; index = output.indexOf('\n[', index + 2)) {
    starts.push(index + 1)
  }
  for (const start of starts.reverse()) {
    try {
      const value = JSON.parse(output.slice(start).trim())
      if (Array.isArray(value)) return value
    } catch {
      // Keep looking for the last line-start JSON array.
    }
  }
  throw new Error('npm pack did not return a JSON report')
}
