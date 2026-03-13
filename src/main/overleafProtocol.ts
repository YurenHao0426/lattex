// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

// Socket.IO v0.9 protocol encoding/decoding

export interface ParsedMessage {
  type: 'disconnect' | 'connect' | 'heartbeat' | 'event' | 'ack' | 'error' | 'noop'
  id?: number
  data?: unknown
  name?: string
  args?: unknown[]
}

/**
 * Parse a Socket.IO v0.9 message frame.
 *
 * Frame format:
 *   0::              disconnect
 *   1::              connect
 *   2::              heartbeat
 *   5:::{"name":"x","args":[...]}         event
 *   5:N+::{"name":"x","args":[...]}       event with ack request
 *   6:::N+[jsonData]                       ack response
 *   8::              noop
 */
export function parseSocketMessage(raw: string): ParsedMessage | null {
  if (!raw || raw.length === 0) return null

  const type = raw[0]

  switch (type) {
    case '0':
      return { type: 'disconnect' }
    case '1':
      return { type: 'connect' }
    case '2':
      return { type: 'heartbeat' }
    case '8':
      return { type: 'noop' }
    case '5': {
      // Event: 5:::{"name":"x","args":[...]} or 5:N+::{"name":"x","args":[...]}
      const ackMatch = raw.match(/^5:(\d+)\+::(.*)$/s)
      if (ackMatch) {
        try {
          const payload = JSON.parse(ackMatch[2])
          return {
            type: 'event',
            id: parseInt(ackMatch[1]),
            name: payload.name,
            args: payload.args || []
          }
        } catch {
          return null
        }
      }
      const evtMatch = raw.match(/^5:::(.*)$/s)
      if (evtMatch) {
        try {
          const payload = JSON.parse(evtMatch[1])
          return { type: 'event', name: payload.name, args: payload.args || [] }
        } catch {
          return null
        }
      }
      return null
    }
    case '6': {
      // Ack: 6:::N+[jsonData]
      const ackMatch = raw.match(/^6:::(\d+)\+([\s\S]*)/)
      if (ackMatch) {
        try {
          const data = JSON.parse(ackMatch[2])
          return { type: 'ack', id: parseInt(ackMatch[1]), data }
        } catch {
          return { type: 'ack', id: parseInt(ackMatch[1]), data: null }
        }
      }
      return null
    }
    default:
      return null
  }
}

/** Encode a Socket.IO v0.9 event (no ack) */
export function encodeEvent(name: string, args: unknown[]): string {
  return '5:::' + JSON.stringify({ name, args })
}

/** Encode a Socket.IO v0.9 event that expects an ack response */
export function encodeEventWithAck(ackId: number, name: string, args: unknown[]): string {
  return `5:${ackId}+::` + JSON.stringify({ name, args })
}

/** Encode a heartbeat response */
export function encodeHeartbeat(): string {
  return '2::'
}
