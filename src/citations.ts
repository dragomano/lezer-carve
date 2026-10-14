import { isAlnum, isWhitespace } from "./source.js"

export function isCitationSpace(c: number): boolean {
  return isWhitespace(c) || (c >= 160 && /\s/u.test(String.fromCharCode(c)))
}

/** Citation keys are case sensitive and use Carve's ASCII key alphabet. */
export function citationKeyEnd(text: string, from: number, to: number): number {
  if (from >= to || (!isAlnum(text.charCodeAt(from)) && text.charCodeAt(from) !== 95)) return from
  let end = from + 1
  while (end < to) {
    const c = text.charCodeAt(end)
    if (!isAlnum(c) && !"_:.#$%&+?<>~/-".includes(text[end])) break
    end++
  }
  return end
}

export interface CitationKey {
  at: number
  end: number
}

export interface CitationItem extends CitationKey {
  from: number
  to: number
}

function lowerBound(values: readonly number[], value: number): number {
  let from = 0,
    to = values.length
  while (from < to) {
    const mid = (from + to) >>> 1
    if (values[mid] < value) from = mid + 1
    else to = mid
  }
  return from
}

/**
 * Index candidate keys and item separators once per inline range. Rejected
 * nested brackets can then be checked without repeatedly scanning their body.
 */
export class CitationIndex {
  private readonly keys: CitationKey[] = []
  private readonly starts: number[] = []
  private readonly commaKeys: CitationKey[] = []
  private readonly commaStarts: number[] = []
  private readonly keyEnds = new Map<number, CitationKey>()
  private readonly separators: number[] = []
  private readonly invalid: number[] = [0]

  constructor(
    private readonly text: string,
    from: number,
    to: number
  ) {
    let escaped = false
    for (let i = from; i < to; i++) {
      const c = text.charCodeAt(i)
      if (c === 64 && !escaped) {
        const end = citationKeyEnd(text, i + 1, to)
        if (end > i + 1) {
          const key = { at: i, end }
          this.keys.push(key)
          this.starts.push(i)
          this.keyEnds.set(end, key)
          if (text.charCodeAt(end) === 44) {
            this.commaKeys.push(key)
            this.commaStarts.push(i)
          }
        }
      }
      // Semicolons delimit items even when escaped or inside a locator.
      if (c === 59) this.separators.push(i)
      escaped = c === 92 && !escaped
    }
    for (let i = 1; i < this.separators.length; i++) {
      const valid = this.item(this.separators[i - 1] + 1, this.separators[i]) != null
      this.invalid.push(this.invalid[i - 1] + (valid ? 0 : 1))
    }
  }

  containsKey(from: number, to: number): boolean {
    const key = this.keys[lowerBound(this.starts, from)]
    return key != null && key.end <= to
  }

  private item(from: number, to: number): CitationItem | null {
    while (from < to && isCitationSpace(this.text.charCodeAt(from))) from++
    while (to > from && isCitationSpace(this.text.charCodeAt(to - 1))) to--
    const comma = this.commaKeys[lowerBound(this.commaStarts, from)]
    const tail = this.keyEnds.get(to)
    let key = comma && comma.end < to ? comma : undefined
    if (tail && tail.at >= from && (!key || tail.at < key.at)) key = tail
    return key ? { ...key, from, to } : null
  }

  items(from: number, to: number): CitationItem[] | null {
    const first = lowerBound(this.separators, from)
    const after = lowerBound(this.separators, to)
    if (first === after) {
      const item = this.item(from, to)
      return item ? [item] : null
    }
    const start = this.item(from, this.separators[first])
    const end = this.item(this.separators[after - 1] + 1, to)
    if (!start || !end || this.invalid[after - 1] !== this.invalid[first]) return null
    const items = [start]
    for (let i = first + 1; i < after; i++) {
      const item = this.item(this.separators[i - 1] + 1, this.separators[i])
      if (!item) return null
      items.push(item)
    }
    items.push(end)
    return items
  }
}
