import type { EngineInterface, Register } from 'claude-code'

// pin-prompt: when you send a prompt, the view follows the reply up the screen
// as it streams, and stops once your prompt is at the top, the way chat apps
// do. Nothing is drawn: no blank rows above or below.
//
// A prompt sent while a reply is still running is left alone: Claude Code
// queues it and draws no row a mod can scroll to (see prompt.submit below).
//
// How: Auto-scroll is off, so the view stays where it is unless moved. While
// the reply streams (read live through `turn.step`), the mod scrolls your
// prompt's row toward the top each time new output arrives. A
// view can't scroll past the end of its content, so each scroll goes only as
// far as the reply allows: the view follows the reply. Once the reply fills
// the window beneath the prompt, the prompt is in place and the mod stops, so
// the rest of the reply fills in below without moving the view.
//
// The engine lets a mod move the transcript only while it answers the
// person's own input, so the mod keeps answering the prompt you sent until the
// prompt is in place or the turn ends. A hook's budget is 10 seconds of its
// own time, timer waits included, while a reply can take minutes to start; so
// between scrolls it waits on a `sleep` process, which the budget does not
// count (it stops while any of the hook's calls is in flight, but a timer's).
//
// Pair it with Auto-scroll off (`autoScrollEnabled: false`): Auto-scroll would
// follow the reply to the bottom, and can't be stopped once a reply streams.
//
// Terminal, fullscreen renderer only. In the classic renderer the terminal owns
// scrolling, so the mod stands aside there.

/** How long to wait for the new prompt's row to be drawn after it is sent. */
const WAIT_MS = 3000
const POLL_MS = 50
/** Once the prompt has entered, how much longer to look for its row. */
const GRACE_MS = 1500
/** How often to bring the view along while new output arrives (`sleep 0.05` below). */
const FOLLOW_MS = 50
/** How often to look for new output while none arrives (`sleep 0.25` below). */
const IDLE_MS = 250
/** How long to keep scrolling after the last new output, while the terminal draws it. */
const TAIL_MS = 400
/** The longest the mod keeps answering a prompt (a safety net; a turn's end stops it first). */
const MAX_FOLLOW_MS = 30 * 60 * 1000
/** Prompt rows remembered with their text; older ones are forgotten so memory stays flat. */
const MAX_ROWS = 100
/** Row ids ever drawn (ids only, so cheap); a redrawn old row is never "new". */
const MAX_SEEN = 5000
/**
 * Rows of the screen that are not transcript (prompt box, status line,
 * spinner). Only used to tell when to stop following: the last scrolls put
 * the prompt exactly in place whatever it is, so too few just stops a little
 * early.
 */
const FOOTER_ROWS = 6
/** Rows of reply past "full" before following stops, to cover the count's error. */
const MARGIN_ROWS = 4
/** Columns the transcript spends on its left margin. */
const GUTTER = 2
/** Rows a tool call takes in the transcript (its line and a short result). */
const TOOL_ROWS = 3

/** QA switch: true shows the mod's notes as transcript lines; false keeps them in the debug log. */
const SHOW_NOTES = false

const note = ($: Pick<EngineInterface, 'ui'>, text: string) =>
  SHOW_NOTES ? $.ui.log(text) : $.ui.log(text, { to: 'debug' })

type Row = { text: string; seq: number }

/**
 * The id the engine draws a just-sent prompt under until its real row replaces
 * it a moment later. It can't be scrolled to (it is gone by then), and it is
 * reused for every prompt, so it never counts as a row of its own.
 */
const PLACEHOLDER_ID = 'placeholder'
type Viewport = { rows: number; columns?: number; isFullscreen?: boolean } | undefined

/** Rows a block of text takes, counted as its pieces arrive: whole lines, and the open one's length. */
type TextRows = { done: number; tail: number }

/** Adds a piece of streamed text to a block's count, at the given width. */
function addText(rows: TextRows, text: string, width: number) {
  const parts = text.split('\n')
  rows.tail += (parts[0] ?? '').length
  for (let i = 1; i < parts.length; i++) {
    rows.done += Math.max(1, Math.ceil(rows.tail / width))
    rows.tail = (parts[i] ?? '').length
  }
}

/** How many rows a block counted so far takes, its blank row above included. */
function rowsOf(rows: TextRows, width: number) {
  return 1 + rows.done + (rows.tail > 0 ? Math.ceil(rows.tail / width) : 0)
}

/** How many rows a whole text takes at a number of columns. */
function estimateRows(text: string, columns: number) {
  const width = Math.max(10, columns - GUTTER)
  const rows: TextRows = { done: 0, tail: 0 }
  addText(rows, text, width)

  return rowsOf(rows, width)
}

export const register: Register = on => {
  // Prompt rows first drawn on the terminal, in draw order: id -> row.
  const rows = new Map<string, Row>()
  const seen = new Set<string>()
  // Prompt rows a submit has already followed, so two submits never share one.
  const claimed = new Set<string>()
  let seq = 0
  let isFullscreen: boolean | undefined
  let screenRows = 0
  let columns = 120
  // Read through a function: the value can change while a submit waits for its row.
  const isClassic = () => isFullscreen === false

  // The main loop's output so far, in rows (an estimate), and a count bumped
  // whenever some arrives. A follower measures from where they stood when it began.
  const output = { rows: 0, version: 0 }
  // Bumped as each main turn ends: a follower ends with the turn it follows in.
  let turnEnds = 0
  // Bumped as each follower starts following: only the newest one scrolls.
  let generation = 0
  // Read through functions: other hooks change them while a submit follows.
  const turnEndsNow = () => turnEnds
  const generationNow = () => generation

  const learn = (viewport: Viewport) => {
    if (viewport?.isFullscreen !== undefined) isFullscreen = viewport.isFullscreen
    if (viewport?.rows) screenRows = viewport.rows
    if (viewport?.columns) columns = viewport.columns
  }

  /** True the first time a row id is drawn. */
  const isFirstDraw = (id: string) => {
    if (seen.has(id)) return false
    seen.add(id)
    if (seen.size > MAX_SEEN) {
      const oldest = seen.values().next().value
      if (oldest !== undefined) seen.delete(oldest)
    }
    return true
  }

  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    learn(e.viewport)
    if (e.requestId === PLACEHOLDER_ID) return next(e)

    if (e.props.origin.kind === 'composer' && isFirstDraw(e.requestId)) {
      seq += 1
      rows.set(e.requestId, { text: e.props.text, seq })
      if (rows.size > MAX_ROWS) {
        const oldest = rows.keys().next().value
        if (oldest !== undefined) {
          rows.delete(oldest)
          claimed.delete(oldest)
        }
      }
    }

    return next(e)
  })

  // The model's response as it streams: count the rows it takes, so a
  // follower knows new output arrived and when its prompt is in place.
  on('turn.step', async function* ($, e, next) {
    const stream = next(e)
    if (e.agentId !== undefined) return yield* stream

    const width = Math.max(10, columns - GUTTER)
    const blocks = new Map<number, { text: TextRows; rows: number }>()
    for await (const chunk of stream) {
      if (chunk.kind === 'text') {
        let block = blocks.get(chunk.index)
        if (!block) {
          block = { text: { done: 0, tail: 0 }, rows: 0 }
          blocks.set(chunk.index, block)
        }
        addText(block.text, chunk.text, width)
        const now = rowsOf(block.text, width)
        output.rows += now - block.rows
        block.rows = now
        output.version += 1
      } else if (chunk.kind === 'tool') {
        output.rows += TOOL_ROWS
        output.version += 1
      }
      yield chunk
    }

    return await stream.result
  })

  on('turn.complete', ($, e, next) => {
    // A subagent's turn ending is not yours: keep following until the main turn ends.
    if (e.agentId === undefined) turnEnds += 1

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const isOwnPrompt = e.origin.kind === 'composer' && !e.command && !e.isMeta
    // Typed while a reply runs, it is queued: Claude Code either slips it into
    // the running turn, drawn as an attachment, or starts the next turn with
    // it, drawn as a row only once the view reaches it. Neither can be scrolled
    // to from here ("nothing drawn under that requestId"), so it is left alone.
    if (!isOwnPrompt || e.turnId !== undefined || isClassic()) return next(e)

    const startSeq = seq
    const promptRows = estimateRows(e.text, columns)
    // The reply to a prompt sent now is everything output from here on.
    const atSubmit = { rows: output.rows, version: output.version }

    // Let the prompt go on its way, and look for its row meanwhile.
    const pending = next(e)
    let isDropped = false
    let entered: string | undefined
    void pending.then(
      r => {
        if ('drop' in r) isDropped = true
        else entered = r.text
      },
      () => {
        isDropped = true
      },
    )

    // An unclaimed prompt row drawn since this submit started whose text matches
    // the prompt (as typed, or as it entered after other hooks). For a prompt
    // sent now, once it has entered and no row matches, fall back to the first
    // new row, since a paste or rewrite can change what the row shows; a queued
    // one waits for its own text, as other prompts may be drawn before it.
    const findNewRow = (): string | undefined => {
      let first: string | undefined
      for (const [id, row] of rows) {
        if (row.seq <= startSeq || claimed.has(id)) continue
        if (row.text === e.text || row.text === entered) return id
        first ??= id
      }
      return entered !== undefined ? first : undefined
    }

    /** Waits on a `sleep` process (see the top of the file); false when it can't. */
    const pause = async (ms: number) => {
      try {
        // Written out in full, so the commands the mod runs read plainly here.
        await $.process.run(ms === FOLLOW_MS ? ['sleep', '0.05'] : ['sleep', '0.25'], { timeoutMs: ms + 5000 })
        return true
      } catch (err) {
        note($, `stopped: could not wait (${String(err)})`)
        return false
      }
    }

    /** Waits for this prompt's row; undefined if it never came or the prompt was dropped. */
    const waitForRow = async (): Promise<string | undefined> => {
      let id = findNewRow()
      let sinceEntered = 0
      for (
        let waited = 0;
        id === undefined && !isDropped && waited < WAIT_MS && sinceEntered < GRACE_MS;
        waited += POLL_MS
      ) {
        try {
          await $.clock.sleep(POLL_MS, { signal: next.signal })
        } catch (err) {
          // Esc, or the dispatch ended: a normal interrupt, not a failure.
          if (next.signal.aborted) return undefined
          throw err
        }
        if (entered !== undefined) sinceEntered += POLL_MS
        id = findNewRow()
      }
      if (!isDropped && id === undefined) note($, 'no prompt row drawn for this prompt; not following')
      return isDropped ? undefined : id
    }

    /**
     * Follows the prompt's row: each time new output arrives, and for a moment
     * after while the terminal draws it, scroll the prompt into place. Stops once
     * the reply has (by count) more than filled the window beneath the prompt and
     * the last of it has been drawn, when the turn ends, or when a newer prompt
     * takes over.
     */
    const follow = async (target: string) => {
      const mine = (generation += 1)
      const myTurnEnds = turnEnds
      const base = atSubmit.rows
      note($, `following ${target}`)

      const window = Math.max(1, screenRows - FOOTER_ROWS - promptRows)
      const fullAt = window + MARGIN_ROWS
      const tailTicks = Math.ceil(TAIL_MS / FOLLOW_MS)
      let seenVersion = atSubmit.version
      // The prompt is already in view, at the bottom: wait for output.
      let ticksLeft = 0
      let isFull = false
      let scrolls = 0
      let waited = 0
      const isMine = () => generationNow() === mine && turnEndsNow() === myTurnEnds

      while (isMine() && waited < MAX_FOLLOW_MS) {
        const ms = ticksLeft > 0 ? FOLLOW_MS : IDLE_MS
        if (!(await pause(ms))) break
        waited += ms
        if (!isMine()) break
        if (output.version !== seenVersion) {
          seenVersion = output.version
          ticksLeft = tailTicks
          if (output.rows - base >= fullAt) isFull = true
        }
        if (ticksLeft === 0) {
          if (isFull) break
          continue
        }
        ticksLeft -= 1

        let deny: string | undefined
        try {
          deny = (await $.ui.scroll({ to: { requestId: target }, block: 'start' })).deny
        } catch (err) {
          deny = String(err)
        }
        if (deny) {
          note($, `stopped following: the view could not be moved (${deny})`)
          break
        }
        scrolls += 1
      }

      if (isFull) note($, `prompt in place; following stopped after ${scrolls} scrolls`)
      else if (generationNow() !== mine) note($, `a newer prompt took over; followed with ${scrolls} scrolls`)
      else if (turnEndsNow() !== myTurnEnds) note($, `turn ended; followed with ${scrolls} scrolls`)
    }

    const id = await waitForRow()
    if (id !== undefined && !isClassic()) {
      claimed.add(id)
      await follow(id)
    }

    return pending
  }).catch(($, e, next) => {
    // Never block a prompt: on any failure, leave a note (see SHOW_NOTES) and
    // let the prompt through.
    note($, 'hook failed; prompt passed through unfollowed')

    return next(e)
  })
}
