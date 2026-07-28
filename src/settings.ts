// User-preference store. Every setting is one stringSetting/boolSetting call,
// so the try/catch-around-storage discipline is written once.

import { defaultStorage, type MinimalStorage } from './storage.js'

export type { MinimalStorage } from './storage.js'

interface Setting<T> {
  get(storage?: MinimalStorage): T
  set(value: T, storage?: MinimalStorage): void
}

function boolSetting(key: string, def: boolean): Setting<boolean> {
  return {
    get(storage = defaultStorage()): boolean {
      try {
        const stored = storage?.getItem(key)
        return stored === null || stored === undefined ? def : stored === '1'
      } catch {
        return def
      }
    },
    set(value, storage = defaultStorage()): void {
      try {
        storage?.setItem(key, value ? '1' : '0')
      } catch {
        // storage unavailable (e.g. private browsing quota) — setting just won't persist
      }
    },
  }
}

function stringSetting(key: string, def: string): Setting<string> {
  return {
    get(storage = defaultStorage()): string {
      try {
        return storage?.getItem(key) ?? def
      } catch {
        return def
      }
    },
    set(value, storage = defaultStorage()): void {
      try {
        storage?.setItem(key, value)
      } catch {
        // storage unavailable (e.g. private browsing quota) — setting just won't persist
      }
    },
  }
}

function numberSetting(key: string, def: number): Setting<number> {
  return {
    get(storage = defaultStorage()): number {
      try {
        const stored = storage?.getItem(key)
        if (stored === null || stored === undefined) return def
        const n = Number(stored)
        return Number.isFinite(n) ? n : def
      } catch {
        return def
      }
    },
    set(value, storage = defaultStorage()): void {
      try {
        storage?.setItem(key, String(value))
      } catch {
        // storage unavailable (e.g. private browsing quota) — setting just won't persist
      }
    },
  }
}

// Defaults on: vim mode was previously hardcoded on, so existing users see no
// change until they opt out.
const vimMode = boolSetting('eventable.vimMode', true)
export const getVimMode = vimMode.get
export const setVimMode = vimMode.set

// Remembered default that prefills the room-join popover; the URL's ?user=
// param is the source of truth for a live room (see main.ts).
const username = stringSetting('eventable.username', '')
export const getUsername = username.get
export const setUsername = username.set

// Opt-in: requesting Web MIDI access pops a browser permission prompt.
const midiEnabled = boolSetting('eventable.midiEnabled', false)
export const getMidiEnabled = midiEnabled.get
export const setMidiEnabled = midiEnabled.set

// Table pane's fraction of the timeline+table column height (see
// pane-divider.tsx) — a floor, since it also grows into whatever the
// content-sized timeline pane above it doesn't want.
const sidePanelSplit = numberSetting('eventable.sidePanelSplit', 0.5)
export const getSidePanelSplit = sidePanelSplit.get
export const setSidePanelSplit = sidePanelSplit.set

// Side panels' fraction of the app width, desktop only — the twin of the split
// above on the other axis (see pane-divider.tsx). Defaults to the 33% the
// stylesheet lays out before a drag.
const canvasSplit = numberSetting('eventable.canvasSplit', 0.33)
export const getCanvasSplit = canvasSplit.get
export const setCanvasSplit = canvasSplit.set
