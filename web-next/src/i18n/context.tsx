'use client'
import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { detectLocale, setLocaleCookie, type Locale, DEFAULT_LOCALE } from './detect'

// Lazy-load messages
const messageLoaders: Record<Locale, () => Promise<Record<string, string>>> = {
  en: () => import('../../messages/en.json').then(m => m.default),
  zh: () => import('../../messages/zh.json').then(m => m.default),
}

interface LocaleContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: (key: string, params?: Record<string, string | number>) => string
  ready: boolean
}

const LocaleContext = createContext<LocaleContextValue>({
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
  t: (key) => key,
  ready: false,
})

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE)
  const [messages, setMessages] = useState<Record<string, string>>({})
  const [ready, setReady] = useState(false)

  // Detect and load on mount
  useEffect(() => {
    const detected = detectLocale()
    setLocaleState(detected)
    loadMessages(detected)
  }, [])

  async function loadMessages(loc: Locale) {
    const msgs = await messageLoaders[loc]()
    setMessages(msgs)
    setReady(true)
    document.documentElement.lang = loc
  }

  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale)
    setLocaleCookie(newLocale)
    // Keep old messages visible during load to prevent FOUC (flash of raw keys)
    loadMessages(newLocale)
  }, [])

  // Translation function with interpolation support
  const t = useCallback((key: string, params?: Record<string, string | number>) => {
    let value = messages[key] ?? key
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        value = value.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
      })
    }
    return value
  }, [messages])

  return (
    <LocaleContext.Provider value={{ locale, setLocale, t, ready }}>
      {ready ? children : (
        <div className="fixed inset-0 flex items-center justify-center">
          <div className="h-6 w-6 rounded-full border-3 border-hxa-accent/20 border-t-hxa-accent animate-spin" />
        </div>
      )}
    </LocaleContext.Provider>
  )
}

export const useTranslations = () => useContext(LocaleContext)
export const useLocale = () => {
  const { locale, setLocale } = useContext(LocaleContext)
  return { locale, setLocale }
}
