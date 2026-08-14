import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"
import { locales } from "../../app/i18n/config"
import { MESSAGE_MODULES } from "../../app/i18n/messages"
import { runtimeConfigFields } from "../../app/components/profile/runtime-config-fields"
import { API_ERROR_CODES } from "../../app/lib/api-codes"

const messageRoot = join(process.cwd(), "app", "i18n", "messages")
const modules = MESSAGE_MODULES

function parseMessageFile(locale: string, moduleName: string) {
  const path = join(messageRoot, locale, `${moduleName}.json`)
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
}

function leafPaths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [prefix]
  return Object.entries(value).flatMap(([key, child]) => (
    leafPaths(child, prefix ? `${prefix}.${key}` : key)
  ))
}

function leafRecord(value: unknown) {
  return Object.fromEntries(leafPaths(value).map(path => {
    let current = value
    for (const segment of path.split(".")) {
      current = typeof current === "object" && current !== null
        ? (current as Record<string, unknown>)[segment]
        : undefined
    }
    return [path, current]
  }))
}

for (const moduleName of modules) {
  const referenceMessages = parseMessageFile("en", moduleName)
  const reference = leafPaths(referenceMessages).sort()
  const referenceLeaves = leafRecord(referenceMessages)
  for (const locale of locales) {
    const localeMessages = parseMessageFile(locale, moduleName)
    const actual = leafPaths(localeMessages).sort()
    assert.deepEqual(actual, reference, `${moduleName}.json locale key structure mismatch: ${locale} must match en`)
    const localeLeaves = leafRecord(localeMessages)
    for (const [path, englishValue] of Object.entries(referenceLeaves)) {
      const localizedValue = localeLeaves[path]
      if (typeof englishValue !== "string" || typeof localizedValue !== "string") continue
      const argumentsIn = (value: string) => [...value.matchAll(/\{\s*([A-Za-z][A-Za-z0-9_]*)\s*(?:,|\})/gu)]
        .map(match => match[1])
        .sort()
      assert.deepEqual(
        argumentsIn(localizedValue),
        argumentsIn(englishValue),
        `${locale}/${moduleName}.json ${path} must preserve ICU argument names`,
      )
    }
  }
}

const englishApi = parseMessageFile("en", "api")
for (const locale of locales) {
  const api = parseMessageFile(locale, "api")
  assert.deepEqual(
    Object.keys(api).sort(),
    [...API_ERROR_CODES].sort(),
    `${locale}/api.json must contain exactly the registered API error codes`,
  )
  for (const code of API_ERROR_CODES) {
    assert.equal(typeof api[code], "string", `${locale}/api.json is missing ${code}`)
    assert((api[code] as string).trim().length > 0, `${locale}/api.json ${code} cannot be empty`)
    if (locale !== "en") {
      assert.notEqual(
        api[code],
        englishApi[code],
        `${locale}/api.json must translate ${code} instead of falling back to English`,
      )
    }
  }
}

for (const locale of locales) {
  const runtime = parseMessageFile(locale, "runtime") as { fields?: Record<string, unknown> }
  assert(runtime.fields, `${locale}/runtime.json must contain fields`)
  for (const path of Object.keys(runtimeConfigFields)) {
    let value: unknown = runtime.fields
    for (const segment of path.split(".")) {
      value = typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)[segment]
        : undefined
    }
    assert(
      typeof value === "object"
        && value !== null
        && typeof (value as Record<string, unknown>).label === "string"
        && typeof (value as Record<string, unknown>).description === "string",
      `${locale}/runtime.json is missing fields.${path}.{label,description}`,
    )
  }
}

const englishSetup = parseMessageFile("en", "setup")
for (const locale of locales.filter(locale => locale !== "en")) {
  assert.notDeepEqual(
    parseMessageFile(locale, "setup"),
    englishSetup,
    `setup ${locale} must not fall back entirely to English`,
  )
}

// Product names and wire-protocol identifiers are intentionally language
// invariant. Every other English sentence/label must actually be translated,
// not merely copied into a locale-specific JSON file.
const invariantCatalogValues = new Set([
  "MoeMail",
  "Cloudflare Email Worker",
  "Resend",
  "TLS",
  "STARTTLS",
  "X-Original-To",
  "Delivered-To",
  "Envelope-To",
  "X-Envelope-To",
  "HTML",
  "IMAP IDLE",
])
const localeFormats = {
  en: { label: "{label}:", labelValue: "{label}: {value}", labelCodeValue: "{label}: <code>{value}</code>", identityRole: "{identity} ({role})" },
  "zh-CN": { label: "{label}\uff1a", labelValue: "{label}\uff1a{value}", labelCodeValue: "{label}\uff1a<code>{value}</code>", identityRole: "{identity}\uff08{role}\uff09" },
  "zh-TW": { label: "{label}\uff1a", labelValue: "{label}\uff1a{value}", labelCodeValue: "{label}\uff1a<code>{value}</code>", identityRole: "{identity}\uff08{role}\uff09" },
  ja: { label: "{label}\uff1a", labelValue: "{label}\uff1a{value}", labelCodeValue: "{label}\uff1a<code>{value}</code>", identityRole: "{identity}\uff08{role}\uff09" },
  ko: { label: "{label}:", labelValue: "{label}: {value}", labelCodeValue: "{label}: <code>{value}</code>", identityRole: "{identity} ({role})" },
} as const
for (const locale of locales) {
  const common = parseMessageFile(locale, "common") as { format?: { label?: string; labelValue?: string; labelCodeValue?: string; identityRole?: string } }
  assert.deepEqual(common.format, localeFormats[locale], `${locale}/common.json must define locale-specific label formatting`)
}
for (const moduleName of modules.filter(moduleName => moduleName !== "api")) {
  const english = leafRecord(parseMessageFile("en", moduleName))
  for (const locale of locales.filter(locale => locale !== "en")) {
    const translated = leafRecord(parseMessageFile(locale, moduleName))
    for (const [path, value] of Object.entries(english)) {
      if (
        typeof value === "string"
        && /[A-Za-z]{2}/u.test(value)
        && translated[path] === value
        && !invariantCatalogValues.has(value)
        && !(moduleName === "common" && path.startsWith("format."))
      ) {
        assert.fail(`${locale}/${moduleName}.json must translate ${path} instead of copying English`)
      }
    }
  }
}

const localizedScripts = /[\u1100-\u11ff\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/u
const englishScriptAllowlist = new Set(["auth.loginForm.subtitle"])
for (const moduleName of modules) {
  const english = parseMessageFile("en", moduleName)
  for (const path of leafPaths(english)) {
    let value: unknown = english
    for (const segment of path.split(".")) {
      value = typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)[segment]
        : undefined
    }
    assert(
      typeof value !== "string"
        || !localizedScripts.test(value)
        || englishScriptAllowlist.has(`${moduleName}.${path}`),
      `en/${moduleName}.json ${path} contains non-English script text`,
    )
  }
}

const roleTranslations = Object.fromEntries(locales.map(locale => {
  const profile = parseMessageFile(locale, "profile") as {
    card?: { roles?: Record<string, string> }
  }
  return [locale, profile.card?.roles]
}))
const roleKeys = ["EMPEROR", "DUKE", "KNIGHT", "CIVILIAN"]
for (const locale of locales) {
  assert.deepEqual(
    Object.keys(roleTranslations[locale] ?? {}).sort(),
    [...roleKeys].sort(),
    `${locale} must translate every persisted role identifier`,
  )
  for (const role of roleKeys) {
    assert(
      roleTranslations[locale]?.[role]?.trim(),
      `${locale} role translation cannot be empty: ${role}`,
    )
  }
}
for (const locale of locales.filter(locale => locale !== "en")) {
  assert.notDeepEqual(
    roleTranslations[locale],
    roleTranslations.en,
    `${locale} role names must not fall back entirely to English`,
  )
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/u.test(entry.name) ? [path] : []
  })
}

// Guard every shared component, metadata-bearing TypeScript module, and page
// instead of maintaining a manual allowlist that can miss newly added UI.
const appRoot = join(process.cwd(), "app")
const guardedUiFiles = [...new Set([
  ...sourceFiles(join(appRoot, "components")),
  ...sourceFiles(join(appRoot, "hooks")),
  ...sourceFiles(join(appRoot, "types")),
  ...sourceFiles(join(appRoot, "config")),
  ...sourceFiles(appRoot).filter(path => path.endsWith(".tsx")),
])]
  .map(path => relative(process.cwd(), path).replaceAll("\\", "/"))
  .sort()
const localizedScript = /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff]/u
const localizedPunctuation = /[\u3002\u300c\u300d\u300e\u300f\u3010\u3011\uff01\uff0c\uff1a\uff1b\uff1f]/u
const machineCode = /^[A-Z][A-Z0-9_]*$/u
const protocolReason = /^(?:[A-Z][A-Z0-9_]*|[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*)$/u
const hardcoded: string[] = []
const hardcodedEnglishJsx: string[] = []
const hardcodedEnglishJsxExpressions: string[] = []
const hardcodedTranslationSeparators: string[] = []
const hardcodedTranslatedPhraseComposition: string[] = []
const hardcodedHumanListSeparators: string[] = []
const hardcodedUiAttributes: string[] = []
const routeResponseProse: string[] = []
const routeReasonProse: string[] = []
const routeVisiblePayloadProse: string[] = []
const backendLocalizedErrors: string[] = []
const translatedAttributes = new Set(["aria-label", "aria-description", "title", "alt"])
const translatableProps = new Set(["description", "label", "placeholder", "title", "tooltip"])
const productNames = new Set(["GitHub", "Google", "PostgreSQL", "SQLite"])
const localizedApiConsumers: string[] = []
const uiLiteralErrorMessages: string[] = []
const unsafeRenderedErrorMessages: string[] = []
const backendNaturalLanguageErrors: string[] = []
const backendNaturalLanguageLogs: string[] = []
const routeNaturalLanguageLogs: string[] = []
const uiNaturalLanguageLogs: string[] = []
const directUiCopy: string[] = []
const routeLocalizedText: string[] = []
const visibleStateSetters = new Set(["setError", "setMessage", "setNotice", "setStatus"])

function jsxElementName(node: ts.JsxElement) {
  const name = node.openingElement.tagName
  return ts.isIdentifier(name) ? name.text : ""
}

function isNonTranslatableJsxText(node: ts.JsxText) {
  if (node.text.trim() === "MoeMail") return true
  let parent: ts.Node | undefined = node.parent
  for (; parent; parent = parent.parent) {
    if (ts.isJsxElement(parent) && ["code", "pre"].includes(jsxElementName(parent))) {
      return true
    }
  }
  return false
}

function isInsideCodeLikeJsx(node: ts.Node) {
  for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
    if (ts.isJsxElement(parent) && ["code", "pre"].includes(jsxElementName(parent))) return true
  }
  return false
}

function isLanguageInvariantUiValue(value: string) {
  return machineCode.test(value)
    || productNames.has(value)
    || value === "MoeMail"
    || /^postgres(?:ql)?:\/\//u.test(value)
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression)
    || ts.isNonNullExpression(expression)
  ) {
    return unwrapExpression(expression.expression)
  }
  return expression
}

function isTranslationExpression(expression: ts.Expression | undefined) {
  if (!expression) return false
  const unwrapped = unwrapExpression(expression)
  if (
    ts.isCallExpression(unwrapped)
    && ts.isIdentifier(unwrapped.expression)
    && /^t(?:[A-Z][A-Za-z0-9]*)?$/u.test(unwrapped.expression.text)
  ) return true

  // The setup wizard retains a typed dictionary proxy (`t.someKey`) while the
  // rest of the UI calls translators (`tSomeNamespace("someKey")`). Treat both
  // forms as translated expressions so punctuation cannot be appended outside
  // the locale catalog.
  return ts.isPropertyAccessExpression(unwrapped)
    && ts.isIdentifier(unwrapped.expression)
    && /^t(?:[A-Z][A-Za-z0-9]*)?$/u.test(unwrapped.expression.text)
}

function renderedLiteralFragments(
  expression: ts.Expression,
  literalBindings?: ReadonlyMap<string, readonly string[]>,
  seen = new Set<string>(),
): string[] {
  if (ts.isIdentifier(expression) && literalBindings?.has(expression.text) && !seen.has(expression.text)) {
    const nextSeen = new Set(seen)
    nextSeen.add(expression.text)
    return [...(literalBindings.get(expression.text) ?? [])]
  }
  if (ts.isStringLiteralLike(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return [expression.text]
  }
  if (ts.isTemplateExpression(expression)) {
    return [expression.head.text, ...expression.templateSpans.map(span => span.literal.text)]
  }
  if (
    ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression)
    || ts.isNonNullExpression(expression)
  ) {
    return renderedLiteralFragments(expression.expression, literalBindings, seen)
  }
  if (ts.isConditionalExpression(expression)) {
    return [
      ...renderedLiteralFragments(expression.whenTrue, literalBindings, seen),
      ...renderedLiteralFragments(expression.whenFalse, literalBindings, seen),
    ]
  }
  if (ts.isBinaryExpression(expression)) {
    if (expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return [
        ...renderedLiteralFragments(expression.left, literalBindings, seen),
        ...renderedLiteralFragments(expression.right, literalBindings, seen),
      ]
    }
    if (
      expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      || expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
      || expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return renderedLiteralFragments(expression.right, literalBindings, seen)
    }
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.flatMap(element => (
      ts.isSpreadElement(element) ? [] : renderedLiteralFragments(element as ts.Expression, literalBindings, seen)
    ))
  }
  return []
}

for (const relativePath of guardedUiFiles) {
  const sourceText = readFileSync(join(process.cwd(), relativePath), "utf8")
  if (/useTranslations\(["']api["']\)/u.test(sourceText)) localizedApiConsumers.push(relativePath)
  const source = ts.createSourceFile(
    relativePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const literalBindings = new Map<string, readonly string[]>()
  const collectLiteralBindings = (node: ts.Node) => {
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node))
      && ts.isIdentifier(node.name)
      && node.initializer
    ) {
      const fragments = renderedLiteralFragments(node.initializer)
      if (fragments.length > 0) literalBindings.set(node.name.text, fragments)
    }
    ts.forEachChild(node, collectLiteralBindings)
  }
  collectLiteralBindings(source)
  const visit = (node: ts.Node) => {
    if (
      ts.isJsxText(node)
      && /^\s*:/u.test(node.text)
      && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) {
      const children = node.parent.children
      const index = children.indexOf(node)
      const previous = index > 0 ? children[index - 1] : undefined
      if (previous && ts.isJsxExpression(previous) && isTranslationExpression(previous.expression)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
        hardcodedTranslationSeparators.push(`${relativePath}:${line + 1}`)
      }
    }
    if (
      ts.isTemplateExpression(node)
      && node.templateSpans.some(span => (
          isTranslationExpression(span.expression) && /^\s*:/u.test(span.literal.text)
      ))
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
      hardcodedTranslationSeparators.push(`${relativePath}:${line + 1}`)
    }
    if (
      ts.isTemplateExpression(node)
      && node.templateSpans.length > 1
      && node.templateSpans.some(span => isTranslationExpression(span.expression))
      && !isInsideCodeLikeJsx(node)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
      hardcodedTranslatedPhraseComposition.push(`${relativePath}:${line + 1}`)
    }
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.PlusToken
      && isTranslationExpression(node.left)
      && renderedLiteralFragments(node.right).some(fragment => /^\s*:/u.test(fragment))
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
      hardcodedTranslationSeparators.push(`${relativePath}:${line + 1}`)
    }
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "join"
      && node.arguments[0]
      && ts.isStringLiteralLike(node.arguments[0])
      && /^(?:,\s+|;\s+|\s+[\u00b7\u2022]\s+)$/u.test(node.arguments[0].text)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
      hardcodedHumanListSeparators.push(`${relativePath}:${line + 1}`)
    }
    if (
      ts.isJsxExpression(node)
      && node.expression
      && !isInsideCodeLikeJsx(node)
      && (
        !ts.isJsxAttribute(node.parent)
        || (ts.isIdentifier(node.parent.name)
          && (translatedAttributes.has(node.parent.name.text) || translatableProps.has(node.parent.name.text)))
      )
    ) {
      for (const fragment of renderedLiteralFragments(node.expression, literalBindings)) {
        if (
          /[A-Za-z]{2}/u.test(fragment)
          && !isLanguageInvariantUiValue(fragment)
        ) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
          hardcodedEnglishJsxExpressions.push(`${relativePath}:${line + 1}`)
        }
      }
    }
    if (
      (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node))
      && (localizedScript.test(node.text) || localizedPunctuation.test(node.text))
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
      hardcoded.push(`${relativePath}:${line + 1}`)
    }
    if (
      ts.isJsxText(node)
      && /[A-Za-z]{2}/u.test(node.text)
      && !isNonTranslatableJsxText(node)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
      hardcodedEnglishJsx.push(`${relativePath}:${line + 1}`)
    }
    if (
      ts.isJsxAttribute(node)
      && ts.isIdentifier(node.name)
      && (translatedAttributes.has(node.name.text) || translatableProps.has(node.name.text))
      && node.initializer
      && ts.isStringLiteral(node.initializer)
      && /[A-Za-z]{2}/u.test(node.initializer.text)
      && !isLanguageInvariantUiValue(node.initializer.text)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
      hardcodedUiAttributes.push(`${relativePath}:${line + 1}:${node.name.text}`)
    }
    if (
      ts.isPropertyAssignment(node)
      && (
        (ts.isIdentifier(node.name) && translatableProps.has(node.name.text))
        || (ts.isStringLiteral(node.name) && translatableProps.has(node.name.text))
      )
      && ts.isStringLiteralLike(node.initializer)
      && /[A-Za-z]{2}/u.test(node.initializer.text)
      && !machineCode.test(node.initializer.text)
      && !productNames.has(node.initializer.text)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.initializer.getStart(source))
      hardcodedUiAttributes.push(`${relativePath}:${line + 1}:${node.name.getText(source)}`)
    }
    if (
      ts.isNewExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "Error"
      && node.arguments?.[0]
      && ts.isStringLiteralLike(node.arguments[0])
      && /[A-Za-z]{2}/u.test(node.arguments[0].text)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.arguments[0].getStart(source))
      uiLiteralErrorMessages.push(`${relativePath}:${line + 1}`)
    }
    if (
      ts.isPropertyAccessExpression(node)
      && node.name.text === "message"
      && ts.isIdentifier(node.expression)
      && ["error", "caught"].includes(node.expression.text)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
      unsafeRenderedErrorMessages.push(`${relativePath}:${line + 1}`)
    }
    if (
      ts.isPropertyAccessExpression(node)
      && node.name.text === "reason"
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "restartRequired"
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
      unsafeRenderedErrorMessages.push(`${relativePath}:${line + 1}`)
    }
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === "console"
      && ["error", "warn", "log"].includes(node.expression.name.text)
      && node.arguments[0]
      && ts.isStringLiteralLike(node.arguments[0])
      && /\s/u.test(node.arguments[0].text)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.arguments[0].getStart(source))
      uiNaturalLanguageLogs.push(`${relativePath}:${line + 1}`)
    }
    if (
      ts.isCallExpression(node)
      && (
        (ts.isIdentifier(node.expression)
          && (["alert", "confirm", "prompt"].includes(node.expression.text)
            || visibleStateSetters.has(node.expression.text)))
        || (ts.isPropertyAccessExpression(node.expression)
          && ts.isIdentifier(node.expression.expression)
          && node.expression.expression.text === "window"
          && ["alert", "confirm", "prompt"].includes(node.expression.name.text))
      )
      && node.arguments[0]
      && ts.isStringLiteralLike(node.arguments[0])
      && (/\p{L}/u.test(node.arguments[0].text) || localizedScript.test(node.arguments[0].text))
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.arguments[0].getStart(source))
      directUiCopy.push(`${relativePath}:${line + 1}`)
    }
    if (
      ts.isNewExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "LocalizedUiError"
      && node.arguments?.[0]
      && ts.isStringLiteralLike(node.arguments[0])
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.arguments[0].getStart(source))
      directUiCopy.push(`${relativePath}:${line + 1}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

assert.deepEqual(hardcoded, [], `UI source contains hardcoded localized text: ${hardcoded.join(", ")}`)
assert.deepEqual(
  hardcodedEnglishJsx,
  [],
  `UI source contains hardcoded English JSX text: ${hardcodedEnglishJsx.join(", ")}`,
)
assert.deepEqual(
  hardcodedEnglishJsxExpressions,
  [],
  `UI source contains hardcoded English JSX expressions: ${hardcodedEnglishJsxExpressions.join(", ")}`,
)
assert.deepEqual(
  hardcodedTranslationSeparators,
  [],
  `Translated labels must obtain locale-specific separators from the catalog: ${hardcodedTranslationSeparators.join(", ")}`,
)
assert.deepEqual(
  hardcodedTranslatedPhraseComposition,
  [],
  `Translated phrases must use one ICU catalog message instead of interpolating translated fragments: ${hardcodedTranslatedPhraseComposition.join(", ")}`,
)
assert.deepEqual(
  hardcodedHumanListSeparators,
  [],
  `Human-readable lists must use the locale formatter rather than fixed separators: ${hardcodedHumanListSeparators.join(", ")}`,
)
assert(
  localizedApiConsumers.length >= 10,
  `API error codes must use the five-locale catalog in major client interactions; found ${localizedApiConsumers.length} consumers`,
)
assert.deepEqual(
  hardcodedUiAttributes,
  [],
  `Visible and accessibility attributes must use i18n: ${hardcodedUiAttributes.join(", ")}`,
)
assert.deepEqual(
  uiLiteralErrorMessages,
  [],
  `UI error paths must translate catalog codes instead of displaying literal Error text: ${uiLiteralErrorMessages.join(", ")}`,
)
assert.deepEqual(
  unsafeRenderedErrorMessages,
  [],
  `UI must not render browser/runtime Error.message; use LocalizedUiError and a translated fallback: ${unsafeRenderedErrorMessages.join(", ")}`,
)
assert.deepEqual(
  uiNaturalLanguageLogs,
  [],
  `UI diagnostics must use stable event identifiers rather than natural-language copy: ${uiNaturalLanguageLogs.join(", ")}`,
)
assert.deepEqual(
  directUiCopy,
  [],
  `Visible dialogs, state messages, and UI errors must come from i18n catalogs: ${directUiCopy.join(", ")}`,
)

// API routes are locale-neutral protocol boundaries. Any user-facing prose in
// an `error` response is an i18n bypass unless it is a stable code. String
// `message` fields are forbidden entirely because they invite clients to
// render protocol values as copy; structured email message objects are fine.
const apiRouteFiles = sourceFiles(join(appRoot, "api"))
  .filter(path => path.endsWith("route.ts"))
for (const path of apiRouteFiles) {
  const relativePath = relative(process.cwd(), path).replaceAll("\\", "/")
  const sourceText = readFileSync(path, "utf8")
  if (localizedScript.test(sourceText) || localizedPunctuation.test(sourceText)) {
    routeLocalizedText.push(relativePath)
  }
  const source = ts.createSourceFile(
    relativePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node)
      && (
        (ts.isIdentifier(node.name) && (node.name.text === "error" || node.name.text === "message"))
        || (ts.isStringLiteral(node.name) && (node.name.text === "error" || node.name.text === "message"))
      )
      && ts.isStringLiteralLike(node.initializer)
      && (
        ((ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === "message")
        || !machineCode.test(node.initializer.text)
      )
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.initializer.getStart(source))
      routeResponseProse.push(`${relativePath}:${line + 1}`)
    }
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === "console"
      && ["error", "warn", "log"].includes(node.expression.name.text)
      && node.arguments[0]
      && ts.isStringLiteralLike(node.arguments[0])
      && /\s/u.test(node.arguments[0].text)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.arguments[0].getStart(source))
      routeNaturalLanguageLogs.push(`${relativePath}:${line + 1}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

assert.deepEqual(
  routeResponseProse,
  [],
  `API responses must return stable codes instead of hardcoded prose: ${routeResponseProse.join(", ")}`,
)
assert.deepEqual(
  routeNaturalLanguageLogs,
  [],
  `API route logs must use stable event identifiers rather than natural-language copy: ${routeNaturalLanguageLogs.join(", ")}`,
)
assert.deepEqual(
  routeLocalizedText,
  [],
  `API route source must remain language-neutral, including comments: ${routeLocalizedText.join(", ")}`,
)

// Shared backend validation/auth helpers are also protocol boundaries. Chinese,
// Japanese or Korean Error/Zod messages would otherwise leak through future
// routes and silently become UI copy.
const backendBoundaryFiles = sourceFiles(join(appRoot, "lib"))
  .map(path => relative(process.cwd(), path).replaceAll("\\", "/"))
  .sort()
for (const relativePath of backendBoundaryFiles) {
  const sourceText = readFileSync(join(process.cwd(), relativePath), "utf8")
  const source = ts.createSourceFile(
    relativePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const visit = (node: ts.Node) => {
    if (
      (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node))
      && (localizedScript.test(node.text) || localizedPunctuation.test(node.text))
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
      backendLocalizedErrors.push(`${relativePath}:${line + 1}`)
    }
    if (
      ts.isNewExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "Error"
      && node.arguments?.[0]
      && ts.isStringLiteralLike(node.arguments[0])
      && !/^[A-Z][A-Z0-9_]*(?::[^\s]+)?$/u.test(node.arguments[0].text)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.arguments[0].getStart(source))
      backendNaturalLanguageErrors.push(`${relativePath}:${line + 1}`)
    }
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === "console"
      && ["error", "warn", "log"].includes(node.expression.name.text)
      && node.arguments[0]
      && ts.isStringLiteralLike(node.arguments[0])
      && /\s/u.test(node.arguments[0].text)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.arguments[0].getStart(source))
      backendNaturalLanguageLogs.push(`${relativePath}:${line + 1}`)
    }
    if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.SuperKeyword
      && node.arguments[0]
      && ts.isStringLiteralLike(node.arguments[0])
      && !/^[A-Z][A-Z0-9_]*(?::[^\s]+)?$/u.test(node.arguments[0].text)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.arguments[0].getStart(source))
      backendNaturalLanguageErrors.push(`${relativePath}:${line + 1}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

// apiError/apiErrorBody are typed, so TypeScript rejects unregistered codes.
// This AST pass additionally proves that every literal code actually used by
// routes/shared request guards remains present in the five-language catalog.
const registeredApiCodes = new Set<string>(API_ERROR_CODES)
const usedApiCodes = new Set<string>()
for (const path of [
  ...apiRouteFiles,
  ...backendBoundaryFiles.map(path => join(process.cwd(), path)),
]) {
  const relativePath = relative(process.cwd(), path).replaceAll("\\", "/")
  const sourceText = readFileSync(path, "utf8")
  const source = ts.createSourceFile(relativePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && (node.expression.text === "apiError" || node.expression.text === "apiErrorBody")
      && node.arguments[0]
      && ts.isStringLiteralLike(node.arguments[0])
    ) {
      usedApiCodes.add(node.arguments[0].text)
      assert(registeredApiCodes.has(node.arguments[0].text), `${relativePath} uses unregistered API error code ${node.arguments[0].text}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}
assert(usedApiCodes.size > 100, "API error-code coverage scan found too few route protocol codes")

// Ingestion endpoints are consumed by Workers/IMAP rather than a locale-aware
// browser. Their public rejection reason must still be a registered protocol
// code; human-readable prose belongs only in the locale catalogs.
for (const path of apiRouteFiles) {
  const relativePath = relative(process.cwd(), path).replaceAll("\\", "/")
  const sourceText = readFileSync(path, "utf8")
  const source = ts.createSourceFile(relativePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node)
      && (
        (ts.isIdentifier(node.name) && node.name.text === "reason")
        || (ts.isStringLiteral(node.name) && node.name.text === "reason")
      )
      && ts.isStringLiteralLike(node.initializer)
      && !protocolReason.test(node.initializer.text)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.initializer.getStart(source))
      routeReasonProse.push(`${relativePath}:${line + 1}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}
assert.deepEqual(
  routeReasonProse,
  [],
  `API reason fields must be machine codes rather than hardcoded prose: ${routeReasonProse.join(", ")}`,
)

// Test/notification payloads are visible to people too. Guard common copy
// fields so a route cannot silently reintroduce one-language sample text.
const routeVisiblePayloadFields = new Set(["subject", "content", "html", "description", "title"])
for (const path of apiRouteFiles) {
  const relativePath = relative(process.cwd(), path).replaceAll("\\", "/")
  const sourceText = readFileSync(path, "utf8")
  const source = ts.createSourceFile(relativePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node)
      && (
        (ts.isIdentifier(node.name) && routeVisiblePayloadFields.has(node.name.text))
        || (ts.isStringLiteral(node.name) && routeVisiblePayloadFields.has(node.name.text))
      )
      && ts.isStringLiteralLike(node.initializer)
      && /[A-Za-z]{2}|[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff]/u.test(node.initializer.text)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.initializer.getStart(source))
      routeVisiblePayloadProse.push(`${relativePath}:${line + 1}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}
assert.deepEqual(
  routeVisiblePayloadProse,
  [],
  `API notification/sample payloads must be localized by their caller: ${routeVisiblePayloadProse.join(", ")}`,
)

assert.deepEqual(
  backendLocalizedErrors,
  [],
  `Backend protocol boundaries contain hardcoded localized prose: ${backendLocalizedErrors.join(", ")}`,
)
assert.deepEqual(
  backendNaturalLanguageErrors,
  [],
  `Backend Error messages must be stable machine codes, never natural-language UI copy: ${backendNaturalLanguageErrors.join(", ")}`,
)
assert.deepEqual(
  backendNaturalLanguageLogs,
  [],
  `Backend diagnostics must use stable event identifiers rather than natural-language copy: ${backendNaturalLanguageLogs.join(", ")}`,
)

console.log(JSON.stringify({
  ok: true,
  locales: locales.length,
  modules: modules.length,
  runtimeFields: Object.keys(runtimeConfigFields).length,
  guardedUiFiles: guardedUiFiles.length,
  guardedApiRoutes: apiRouteFiles.length,
  guardedBackendFiles: backendBoundaryFiles.length,
  localizedApiConsumers: localizedApiConsumers.length,
}))
