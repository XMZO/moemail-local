const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4",
  "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section",
  "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
])
const HIDDEN_TAGS = new Set(["head", "noscript", "script", "style", "template"])
const ENTITY_PATTERN = /&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/giu
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
}

function decodeEntity(entity: string) {
  const normalized = entity.toLowerCase()
  if (!normalized.startsWith("#")) return NAMED_ENTITIES[normalized] ?? `&${entity};`
  const hexadecimal = normalized.startsWith("#x")
  const codePoint = Number.parseInt(normalized.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10)
  if (
    !Number.isSafeInteger(codePoint)
    || codePoint <= 0
    || codePoint > 0x10ffff
    || (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) return "�"
  return String.fromCodePoint(codePoint)
}

function tagEnd(html: string, start: number) {
  let quote = ""
  for (let index = start + 1; index < html.length; index += 1) {
    const character = html[index]
    if (quote) {
      if (character === quote) quote = ""
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === ">") {
      return index
    }
  }
  return -1
}

function tagName(value: string) {
  return /^<\/?\s*([a-z][a-z0-9:-]*)/iu.exec(value)?.[1]?.toLowerCase() ?? ""
}

function imageAlt(tag: string) {
  const match = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu.exec(tag)
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? ""
}

/**
 * Creates a deterministic plain-text alternative without executing HTML.
 * This is a single forward scan (plus bounded indexOf jumps for hidden
 * elements), so a 2 MiB adversarial body cannot trigger regex backtracking.
 */
export function htmlToPlainText(html: string) {
  const lowercase = html.toLowerCase()
  const fragments: string[] = []
  let cursor = 0

  while (cursor < html.length) {
    const opening = html.indexOf("<", cursor)
    if (opening < 0) {
      fragments.push(html.slice(cursor))
      break
    }
    fragments.push(html.slice(cursor, opening))

    if (html.startsWith("<!--", opening)) {
      const commentEnd = html.indexOf("-->", opening + 4)
      cursor = commentEnd < 0 ? html.length : commentEnd + 3
      continue
    }

    const closing = tagEnd(html, opening)
    if (closing < 0) {
      fragments.push(html.slice(opening))
      break
    }
    const tag = html.slice(opening, closing + 1)
    const name = tagName(tag)
    const isClosingTag = /^<\s*\//u.test(tag)

    if (!isClosingTag && HIDDEN_TAGS.has(name)) {
      const hiddenClose = lowercase.indexOf(`</${name}`, closing + 1)
      if (hiddenClose < 0) {
        cursor = html.length
        continue
      }
      const hiddenEnd = tagEnd(html, hiddenClose)
      cursor = hiddenEnd < 0 ? html.length : hiddenEnd + 1
      fragments.push("\n")
      continue
    }
    if (!isClosingTag && name === "img") {
      const alt = imageAlt(tag)
      if (alt) fragments.push(` ${alt} `)
    }
    if (BLOCK_TAGS.has(name)) fragments.push("\n")
    cursor = closing + 1
  }

  return fragments.join("")
    .replace(ENTITY_PATTERN, (_match, entity: string) => decodeEntity(entity))
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t\f\v ]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim()
}
