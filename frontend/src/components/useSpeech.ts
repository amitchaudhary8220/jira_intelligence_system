// Voice input with the browser's built-in Web Speech API (Chrome / Edge).
// No API key, nothing to install. Note: Chrome sends the audio to Google to transcribe.
//
// Voice is ENGLISH ONLY for now (en-IN, the Indian English recogniser). Typing works in English or Hindi.
// The Hindi recogniser (hi-IN, returns Devanagari) is kept in the type for later, but not offered in the UI.

import { useCallback, useEffect, useRef, useState } from 'react'

export type VoiceLang = 'en-IN' | 'hi-IN'
export const VOICE_LANGS: { id: VoiceLang; label: string }[] = [
  { id: 'en-IN', label: 'English' },
]

// Minimal typing for the parts of SpeechRecognition we use (not in TypeScript's DOM lib everywhere).
type Recognition = {
  lang: string
  interimResults: boolean
  continuous: boolean
  maxAlternatives: number
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}
type RecognitionCtor = new () => Recognition

function getCtor(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

const ERRORS: Record<string, string> = {
  'not-allowed': 'Microphone is blocked. Allow it from the 🔒 icon in the address bar.',
  'service-not-allowed': 'Microphone is blocked. Allow it from the 🔒 icon in the address bar.',
  'no-speech': "Didn't hear anything. Tap the mic and try again.",
  'audio-capture': 'No microphone found.',
  network: 'Voice needs an internet connection (Chrome transcribes speech online).',
}

const SILENCE_MS = 1200   // stop listening this long after the last recognised word

function readLang(): VoiceLang {
  try {
    const v = localStorage.getItem('voiceLang') as VoiceLang | null
    return VOICE_LANGS.some((l) => l.id === v) ? v! : 'en-IN'   // an earlier "Hindi" choice falls back to English
  } catch {
    return 'en-IN'
  }
}

/** onFinal is called once with the full sentence when the speaker stops. */
export function useSpeech(onFinal: (text: string) => void) {
  const supported = getCtor() !== null
  const [listening, setListening] = useState(false)
  const [interim, setInterim] = useState('')
  const [error, setError] = useState('')
  const [lang, setLangState] = useState<VoiceLang>(readLang)
  const recRef = useRef<Recognition | null>(null)
  const finalRef = useRef('')
  const liveRef = useRef('')                       // latest words heard (final + in-progress)
  const silenceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onFinalRef = useRef(onFinal)
  useEffect(() => { onFinalRef.current = onFinal }, [onFinal])
  useEffect(() => () => { recRef.current?.abort(); if (silenceRef.current) clearTimeout(silenceRef.current) }, [])

  const setLang = useCallback((l: VoiceLang) => {
    setLangState(l)
    try { localStorage.setItem('voiceLang', l) } catch { /* private mode: fine */ }
  }, [])

  const start = useCallback(() => {
    const Ctor = getCtor()
    if (!Ctor) return
    recRef.current?.abort()
    const rec = new Ctor()
    rec.lang = lang
    rec.interimResults = true      // show words while speaking
    rec.continuous = false         // one question per tap; stops on a pause
    rec.maxAlternatives = 1
    finalRef.current = ''
    liveRef.current = ''
    setError('')
    setInterim('')
    rec.onresult = (e) => {
      let live = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal) finalRef.current += r[0].transcript
        else live += r[0].transcript
      }
      liveRef.current = (finalRef.current + ' ' + live).trim()
      setInterim(liveRef.current)
      // Chrome's Hindi recogniser is slow to decide a sentence is finished. Stop ourselves after a short
      // pause, so every language feels as quick as English.
      if (silenceRef.current) clearTimeout(silenceRef.current)
      silenceRef.current = setTimeout(() => rec.stop(), SILENCE_MS)
    }
    rec.onerror = (e) => { if (e.error !== 'aborted') setError(ERRORS[e.error] ?? `Voice error: ${e.error}`) }
    rec.onend = () => {
      if (silenceRef.current) clearTimeout(silenceRef.current)
      setListening(false)
      // Use the final text; if the recogniser stopped before marking anything final (common in hi-IN),
      // fall back to the last words it showed instead of dropping them.
      const text = finalRef.current.trim() || liveRef.current.trim()
      setInterim('')
      if (text) onFinalRef.current(text)
    }
    recRef.current = rec
    rec.start()
    setListening(true)
  }, [lang])

  const stop = useCallback(() => recRef.current?.stop(), [])
  const toggle = useCallback(() => (listening ? stop() : start()), [listening, start, stop])

  return { supported, listening, interim, error, lang, setLang, start, stop, toggle, clearError: () => setError('') }
}
