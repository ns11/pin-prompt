# pin-prompt

A Claude Code mod that makes the terminal behave like a chat app. When you
send a prompt, the view follows the reply up the screen as it streams, and
stops once your prompt reaches the top. The reply then fills the screen below
your prompt, and the view stays put while the rest of it arrives.

It adds no blank rows above or below the conversation.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install pin-prompt --marketplace ns11/pin-prompt
```

Answer `y` to add the marketplace, then pick a scope (user is first).

From a shell:

```
claude plugin install pin-prompt --marketplace ns11/pin-prompt
```

## Requirements

- **Fullscreen renderer:** set `"tui": "fullscreen"` in `~/.claude/settings.json`.
  In the classic renderer the terminal owns scrolling, so the mod does nothing there.
- **Auto-scroll off:** set `"autoScrollEnabled": false`. Auto-scroll follows the
  reply to the bottom, and it can't be stopped once a reply is streaming.
- **Terminal only.** The desktop app isn't supported yet.

## How it works

While a reply streams, which the mod reads live through `turn.step`, it scrolls
your prompt's row toward the top of the screen each time new output arrives.
The view can't scroll past the end of the content, so each scroll goes only as
far as the reply allows, and the view follows the reply. Once the reply fills
the screen below your prompt, the mod stops scrolling.

Claude Code lets a mod move the transcript only while the mod is answering your
own input. So the mod keeps its `prompt.submit` hook running until your prompt
is in place or the turn ends.

**What each hook does:**

- `prompt.submit`: lets your prompt through unchanged, finds its row, and
  follows it as described above until it is in place or the turn ends. A
  prompt sent while Claude is working, a slash command, or one from another
  device is passed straight through.
- `turn.step`: counts the rows the reply takes as it streams, to know when new
  output arrives and when the prompt is in place. Every chunk passes through
  unchanged.
- `turn.complete`: notes that the main turn ended, so following stops.
- `ui.render` on `UserMessage`: records which prompt rows are drawn, with their
  text. It draws nothing: each row is passed through as it is.

**What it sends, and where:** nothing. The mod makes no network calls, reads
and writes no files, and stores nothing between sessions. Its notes go to the
debug log only.

**It runs `sleep` processes.** A hook gets 10 seconds of its own time, and
timer waits count toward that, but a reply can take minutes to start. So the
mod waits between scrolls on `sleep 0.05` (while output arrives) and
`sleep 0.25` (while none does) processes, which the budget doesn't count.
While a reply streams, that's up to about 20 short processes a second. Because of this, the plugin report lists the mod as able
to start programs. It starts nothing else.

## Limits

- **Prompts sent while Claude is still working are left alone.** Claude Code
  queues them, and none of the ways it draws a queued prompt can be scrolled to
  by a mod:
  - slipped into the running turn, it's drawn as an attachment;
  - started as the next turn, its row is drawn only once the view reaches it,
    and with Auto-scroll off the view never does.
- **When to stop is estimated.** The transcript doesn't report the prompt's
  position while a reply streams, so the mod counts the reply's rows from its
  text and tool calls.

These limits and what Claude Code could do about them are in
[anthropics/claude-code#111670](https://github.com/anthropics/claude-code/issues/111670).

## Future features

- **Double scroll at the bottom switches to Auto-scroll for the rest of the
  reply.** Once your prompt is at the top and following has stopped, new output
  arrives below and "Jump to bottom" shows. Scroll down to the bottom, then
  scroll down once more where nothing more can move. That extra scroll turns on
  Auto-scroll for the rest of the running reply. The next prompt goes back to
  the normal behavior: follow, then stop at the top.
  This needs Claude Code to let a mod see scrolls on the transcript, which it
  doesn't yet: `ui.scroll` hooks cover panes and the band above the prompt only.
- **Prompts sent while Claude is working:** bring the prompt into view with the
  end of the previous reply above it, then follow as usual. This needs one of
  the changes in #111670.
- **Desktop app support.**

## Develop

```
claude plugin validate .
claude plugin test .
```

To see the mod's notes in the transcript, set `SHOW_NOTES = true` in
`hooks/register.tsx`. Otherwise they go to the debug log (`claude --debug`).

## License

MIT
