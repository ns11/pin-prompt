import { expect, mock, test } from 'claude-code/testing'
import type { Chunk, On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const COMPOSER = { kind: 'composer' } as const
// The test kit has no transcript to scroll: the mod's first scroll of the
// transcript fails there ("no implementation for ui.scroll"), and the mod stops
// following with a note saying so. So these tests read that note as "a scroll
// was tried", and cover when the mod tries, that it stays answering the prompt
// until the turn ends, and what it leaves alone. The view following the reply
// up and stopping with the prompt at the top is checked in a live session.
const TRIED = 'stopped following: the view could not be moved'
const VIEW = { columns: 120, rows: 40, isFullscreen: true }

type World = {
  /** When true, a sent prompt's row is not drawn as it enters (a queued prompt): the test draws it. */
  drawLater?: boolean
  /** What the model streams on the next `turn.step`. */
  chunks: Chunk<'turn.step'>[]
  notes: string[]
}

const tries = (world: World) => world.notes.filter(n => n.startsWith(TRIED)).length

/**
 * Plays the engine beneath the mod: a clock the test moves, a prompt that
 * draws its row as it enters, a model that streams what the test gives it, and
 * a transcript that records the scrolls asked of it.
 */
function engine($: Engine, on: On, start: { isFullscreen?: boolean; shownText?: string } = {}) {
  const world: World = { chunks: [], notes: [] }
  const clock = mock.clock(on)

  // The mod waits between beats on a `sleep` process: here a fake one, which
  // ends when the test's time (moved by `clock.advance` below) reaches it.
  const sleepers: { due: number; done: () => void }[] = []
  let now = 0
  on('process.run', (_, e) =>
    new Promise(resolve => {
      sleepers.push({
        due: now + Number(e.argv[1]) * 1000,
        done: () => resolve({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }),
      })
    }),
  )
  const mockClock = clock
  /** Moves the test's time in small steps, ending the fake sleeps as it goes. */
  const advance = async (ms: number) => {
    for (let left = ms; left > 0; left -= 50) {
      now += Math.min(50, left)
      for (const s of sleepers.filter(s => s.due <= now)) {
        sleepers.splice(sleepers.indexOf(s), 1)
        s.done()
      }
      await mockClock.advance(Math.min(50, left))
    }
  }
  on('ui.log', (_, e) => {
    world.notes.push(e.text)

    return { value: undefined }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('turn.step', async function* (_, e) {
    for (const chunk of world.chunks) yield chunk

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })

  let n = 0
  on('prompt.submit', async (_, e) => {
    if (world.drawLater) return { text: e.text }
    n += 1
    // The stand-in drawn first, then the real row, as seen live.
    for (const id of ['placeholder', `msg-${n}`]) {
      await $.ui.render({
        surface: 'terminal',
        component: 'UserMessage',
        requestId: id,
        viewport: { ...VIEW, isFullscreen: start.isFullscreen ?? true },
        props: { text: start.shownText ?? e.text, origin: COMPOSER, isExpanded: false },
      })
    }

    return { text: e.text }
  })

  return { world, clock: { advance, settle: () => mockClock.settle() } }
}

/** Draws a prompt row, as the engine does once the session takes a queued prompt. */
const drawRow = ($: Engine, requestId: string, text: string) =>
  $.ui.render({
    surface: 'terminal',
    component: 'UserMessage',
    requestId,
    viewport: VIEW,
    props: { text, origin: COMPOSER, isExpanded: false },
  })

type Clock = { advance: (ms: number) => Promise<void>; settle: () => Promise<void> }

/** Sends a prompt and lets the mod find its row; returns the pending result. */
async function sendIt($: Engine, clock: Clock, text: string, extra: Partial<Parameters<Engine['prompt']['submit']>[0]> = {}) {
  const sent = $.prompt.submit({ text, wait: false, origin: COMPOSER, ...extra })
  await clock.advance(300)

  return sent
}

const lines = (count: number, from = 0) =>
  Array.from({ length: count }, (_, i) => ({ kind: 'text' as const, index: 0, text: `line ${from + i}\n` }))

/** Streams a model response and lets the mod's follow loop run after it. */
async function stream($: Engine, world: World, clock: Clock, chunks: Chunk<'turn.step'>[], agentId?: string) {
  world.chunks = chunks
  const out: Chunk<'turn.step'>[] = []
  const s = $.turn.step({ turnId: 'turn-1', index: 0, model: 'test-model', messageCount: 1, ...(agentId ? { agentId } : {}) })
  for await (const chunk of s) out.push(chunk)
  await s.result
  await clock.advance(1000)

  return out
}

const endTurn = async ($: Engine, clock: Clock, agentId?: string) => {
  await $.turn.complete({
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    turnId: 'turn-1',
    reason: 'answer',
    ...(agentId ? { agentId } : {}),
  })
  await clock.advance(200)
}

test('no scroll is tried before the reply has output, however long that takes', async ($, on) => {
  const { world, clock } = engine($, on)
  void sendIt($, clock, 'explain this')
  await clock.advance(5000)

  expect(world.notes).toEqual(['following msg-1'])
})

test('new output brings a scroll of the prompt row, and the prompt goes through unchanged', async ($, on) => {
  const { world, clock } = engine($, on)
  const sent = sendIt($, clock, 'explain this')

  await stream($, world, clock, lines(5))
  expect(tries(world)).toBe(1)

  await endTurn($, clock)
  expect(await sent).toEqual({ text: 'explain this' })
})

test('the mod keeps answering the prompt while the reply has not started, then lets go at the turn end', async ($, on) => {
  const { world, clock } = engine($, on)
  const sent = sendIt($, clock, 'explain this')
  let isAnswered = false
  void sent.then(() => {
    isAnswered = true
  })

  // Longer than a hook's 10 s budget: the mod waits on `sleep` processes, not timers.
  await clock.advance(15000)
  expect(isAnswered).toBe(false)

  await endTurn($, clock)
  await clock.advance(500)
  expect(isAnswered).toBe(true)
  expect(world.notes).toContain('turn ended; followed with 0 scrolls')
})

test('tool calls count as output', async ($, on) => {
  const { world, clock } = engine($, on)
  void sendIt($, clock, 'explain this')

  await stream($, world, clock, [{ kind: 'tool', index: 0, id: 'tool-1', name: 'Bash' }])

  expect(tries(world)).toBe(1)
})

test('the reply passes through the mod unchanged', async ($, on) => {
  const { world, clock } = engine($, on)
  void sendIt($, clock, 'explain this')

  const chunks = lines(30)
  expect(await stream($, world, clock, chunks)).toEqual(chunks)
})

test("a subagent's output brings no scroll, and its turn ending does not stop following", async ($, on) => {
  const { world, clock } = engine($, on)
  void sendIt($, clock, 'explain this')

  await stream($, world, clock, lines(10), 'agent-7')
  expect(tries(world)).toBe(0)

  await endTurn($, clock, 'agent-7')
  await stream($, world, clock, lines(3))
  expect(tries(world)).toBe(1)
})

test('after a scroll fails, the mod stops trying for the rest of the turn', async ($, on) => {
  const { world, clock } = engine($, on)
  void sendIt($, clock, 'explain this')

  await stream($, world, clock, lines(10))
  await stream($, world, clock, lines(10, 10))

  expect(tries(world)).toBe(1)
})

test('two prompts in a row each follow their own row', async ($, on) => {
  const { world, clock } = engine($, on)
  void sendIt($, clock, 'first')
  await stream($, world, clock, lines(3))
  await endTurn($, clock)

  void sendIt($, clock, 'second')
  await stream($, world, clock, lines(3))

  expect(world.notes.filter(n => n.startsWith('following'))).toEqual(['following msg-1', 'following msg-2'])
  expect(tries(world)).toBe(2)
})

test('a row whose text differs from the prompt (paste, rewrite) is still followed', async ($, on) => {
  const { world, clock } = engine($, on, { shownText: 'explain this [Pasted text]' })
  void sendIt($, clock, 'explain this')

  await stream($, world, clock, lines(3))

  expect(world.notes[0]).toBe('following msg-1')
})

test('a slash command is not followed', async ($, on) => {
  const { world, clock } = engine($, on)
  const sent = sendIt($, clock, '/help', { command: { name: 'help', args: '' } })
  await stream($, world, clock, lines(5))

  expect(await sent).toEqual({ text: '/help' })
  expect(world.notes).toEqual([])
})

test('a prompt sent mid-reply is left alone, and the prompt before it keeps being followed', async ($, on) => {
  const { world, clock } = engine($, on)
  void sendIt($, clock, 'explain this')
  await clock.advance(500)

  world.drawLater = true
  void sendIt($, clock, 'and also this', { turnId: 'turn-1' })
  await drawRow($, 'msg-q', 'and also this')
  await clock.advance(1000)

  expect(world.notes).toEqual(['following msg-1'])
})

test('a prompt from another origin (a phone) is not followed', async ($, on) => {
  const { world, clock } = engine($, on)
  void sendIt($, clock, 'from my phone', { origin: { kind: 'bridge' } })
  await stream($, world, clock, lines(5))

  expect(world.notes).toEqual([])
})

test('the classic renderer is left alone', async ($, on) => {
  const { world, clock } = engine($, on, { isFullscreen: false })
  const sent = sendIt($, clock, 'explain this')
  await stream($, world, clock, lines(5))

  expect(await sent).toEqual({ text: 'explain this' })
  expect(world.notes).toEqual([])
})

test('a stream with no prompt being followed is left alone', async ($, on) => {
  const { world, clock } = engine($, on)

  const chunks = lines(30)
  expect(await stream($, world, clock, chunks)).toEqual(chunks)
  expect(world.notes).toEqual([])
})
