// Pure facts about speech-to-text providers and audio files. No
// network and no server-only imports, so they can be unit-tested.

import type { AIProviderDoc } from '@/lib/db/types'

/** Presets whose API exposes /audio/transcriptions. */
export const SPEECH_PRESET_IDS = ['groq', 'openai'] as const
const SPEECH_PRESETS = new Set<string>(SPEECH_PRESET_IDS)

/** Default model per preset — both are Whisper behind the scenes. */
const DEFAULT_MODEL: Record<string, string> = {
  groq: 'whisper-large-v3-turbo',
  openai: 'whisper-1',
}

/** Models worth offering in the picker; the operator can type any. */
export const SPEECH_MODELS: Record<string, string[]> = {
  groq: ['whisper-large-v3-turbo', 'whisper-large-v3'],
  openai: ['whisper-1', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe'],
}

export function canTranscribe(provider: Pick<AIProviderDoc, 'preset' | 'kind'>): boolean {
  return provider.kind === 'openai_compatible' && SPEECH_PRESETS.has(provider.preset)
}

export function transcriptionModel(provider: Pick<AIProviderDoc, 'preset'>): string {
  return DEFAULT_MODEL[provider.preset] ?? 'whisper-1'
}

/** WhatsApp sends opus in ogg; the APIs want a filename they recognise. */
export function filenameFor(mime: string | null): string {
  if (!mime) return 'voice.ogg'
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'voice.mp3'
  if (mime.includes('mp4') || mime.includes('m4a')) return 'voice.m4a'
  if (mime.includes('wav')) return 'voice.wav'
  if (mime.includes('webm')) return 'voice.webm'
  return 'voice.ogg'
}


/**
 * A one-second 440Hz tone as a WAV file: something real to send a
 * transcription endpoint when testing a key and model, without shipping
 * a recording. 16-bit mono PCM at 16kHz, quiet enough not to clip.
 */
export function testToneWav(seconds = 1): Uint8Array {
  const rate = 16_000
  const samples = rate * seconds
  const bytes = new Uint8Array(44 + samples * 2)
  const view = new DataView(bytes.buffer)
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  write(0, 'RIFF')
  view.setUint32(4, 36 + samples * 2, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, samples * 2, true)
  for (let i = 0; i < samples; i++) {
    view.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 3000), true)
  }
  return bytes
}
