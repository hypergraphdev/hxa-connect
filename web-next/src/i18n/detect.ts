export type Locale = 'en' | 'zh'
export const SUPPORTED_LOCALES: Locale[] = ['en', 'zh']
export const DEFAULT_LOCALE: Locale = 'en'

export function detectLocale(): Locale {
  // SSR guard: document is not available on the server
  if (typeof document === 'undefined') return DEFAULT_LOCALE

  // 1. Read NEXT_LOCALE cookie (set by hxa-connect-web landing page)
  const cookieMatch = document.cookie.match(/NEXT_LOCALE=(\w+)/)
  if (cookieMatch) {
    const val = cookieMatch[1] as string
    if (SUPPORTED_LOCALES.includes(val as Locale)) return val as Locale
  }

  // 2. Browser language
  const browserLang = navigator.language?.split('-')[0]
  if (SUPPORTED_LOCALES.includes(browserLang as Locale)) return browserLang as Locale

  // 3. Fallback
  return DEFAULT_LOCALE
}

export function setLocaleCookie(locale: Locale) {
  if (typeof document === 'undefined') return
  document.cookie = `NEXT_LOCALE=${locale};path=/;max-age=31536000;samesite=lax;secure`
}
