export const FILTERED_VALUE = '[Filtered]'

const PRIVATE_KEY_PATTERN = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
const API_KEY_PATTERNS = [
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
]
const CARD_CANDIDATE_PATTERN = /\b(?:\d[ -]?){12,18}\d\b/g
// Only characters a URL can be made of (RFC 3986 unreserved, reserved and
// percent-encoding), so a URL quoted inside prose stops where the prose resumes.
// The previous pattern ran to the next whitespace, which in CJK text — written
// without spaces — swallowed the rest of the sentence: "https://example.com/…；
// 小组件只会在此域名上运行" parsed as one URL whose path was percent-encoded,
// the text no longer round-tripped, and plain help copy was masked as a secret.
const HTTP_URL_PATTERN = /\bhttps?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&()*+,;=%]+/g
const FIELD_SEMANTIC_KEYS = new Set(['type', 'autocomplete', 'name', 'id', 'aria_label', 'placeholder'])
const VALUE_ATTRIBUTE_KEYS = new Set(['value', 'content'])
const SENSITIVE_INPUT_TYPES = new Set(['password', 'hidden', 'file'])
const SENSITIVE_AUTOCOMPLETE = new Set([
  'current_password',
  'new_password',
  'one_time_code',
  'cc_number',
  'cc_csc',
  'cc_exp',
  'cc_exp_month',
  'cc_exp_year',
])
const SENSITIVE_KEY_PATTERN = /(?:^|_)(?:password|passwd|passcode|card_(?:number|no)(?:_[0-9]+)?|credit_card|cc_(?:number|num|csc|cvv|cvc|exp|expiry)|cvv|cvc|csc|security_code|one_time_(?:code|password)|otp(?:_code)?|verification_code|auth(?:entication)?_token|access_token|refresh_token|id_token|token|api_key|client_secret|secret|authorization|cookie|set_cookie|credential|private_key|hidden_value|file_name|filename)(?:$|_(?:value|field|input|confirmation|confirm|header|data|pem)$)/

export function filterSensitiveText(value: string): string {
  let filtered = value
    .replace(PRIVATE_KEY_PATTERN, FILTERED_VALUE)
    .replace(JWT_PATTERN, FILTERED_VALUE)

  for (const pattern of API_KEY_PATTERNS) {
    filtered = filtered.replace(pattern, FILTERED_VALUE)
  }

  filtered = filtered.replace(CARD_CANDIDATE_PATTERN, candidate => (
    passesLuhn(candidate) ? FILTERED_VALUE : candidate
  ))

  return filtered.replace(HTTP_URL_PATTERN, redactUrl)
}

// A bare URL is not a secret: only its query, fragment and embedded credentials
// can carry one. Those parts are dropped; a URL without them is returned
// verbatim so that the text still round-trips and nothing treats it as
// sensitive. An unparseable URL fails closed to the filtered marker.
function redactUrl(candidate: string): string {
  // Punctuation that closes the sentence or bracket around a URL is part of
  // the prose, not the URL — it is set aside and put back after the redaction.
  const trailing = /[.,;:!?)\]]+$/.exec(candidate)?.[0] ?? ''
  let url: URL
  try {
    url = new URL(candidate.slice(0, candidate.length - trailing.length))
  } catch {
    return FILTERED_VALUE
  }
  if (!url.search && !url.hash && !url.username && !url.password) return candidate
  return `${url.origin}${url.pathname}${trailing}`
}

export function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`
  } catch {
    return ''
  }
}

export function filterSensitiveValue<T>(value: T, key?: string): T {
  if (key && isSensitiveKey(key) && value != null) return FILTERED_VALUE as T
  if (typeof value === 'string') return filterSensitiveText(value) as T
  if (Array.isArray(value)) return value.map(item => filterSensitiveValue(item)) as T
  if (value && typeof value === 'object') {
    const sensitiveField = isSensitiveFieldAttributes(value as Record<string, unknown>)
    const filtered = Object.fromEntries(
      Object.entries(value).map(([nestedKey, item]) => {
        const filteredItem = sensitiveField && VALUE_ATTRIBUTE_KEYS.has(normalizeIdentifier(nestedKey)) && item != null
          ? FILTERED_VALUE
          : filterSensitiveValue(item, nestedKey)
        return [filterSensitiveText(nestedKey), filteredItem]
      }),
    )
    return filtered as T
  }
  return value
}

export function isSensitiveKey(value: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(normalizeIdentifier(value))
}

export function isSensitiveFieldAttributes(attributes: Record<string, unknown>): boolean {
  return Object.entries(attributes).some(([key, value]) => {
    if (typeof value !== 'string') return false

    const normalizedKey = normalizeIdentifier(key)
    if (!FIELD_SEMANTIC_KEYS.has(normalizedKey)) return false
    if (normalizedKey === 'type') return SENSITIVE_INPUT_TYPES.has(normalizeIdentifier(value))
    if (normalizedKey === 'autocomplete') {
      return value.split(/\s+/).some(token => SENSITIVE_AUTOCOMPLETE.has(normalizeIdentifier(token)))
    }
    return isSensitiveKey(value)
  })
}

function normalizeIdentifier(value: string): string {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function passesLuhn(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, '')
  if (digits.length < 13 || digits.length > 19) return false

  let sum = 0
  let doubleDigit = false
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index])
    if (doubleDigit) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    doubleDigit = !doubleDigit
  }
  return sum % 10 === 0
}
