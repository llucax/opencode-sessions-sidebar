import type { TuiPlugin, TuiPluginApi, TuiPluginModule, TuiRouteCurrent } from "@opencode-ai/plugin/tui"

// Toggles back to the session you were in before the current one, the way
// tapping Alt+Tab once switches between the two most recent windows. Bound to
// ctrl+space by default, and also reachable from the command palette.
//
// This file carries no JSX and needs no reactive transform, but it keeps the
// .tsx extension anyway to sit beside sessions-sidebar.tsx, which does need
// it.

const ID = "sessions-switch"

// TuiPluginApi's `route.current` is a plain getter (see routeCurrent() in
// opencode's adapters.tsx), not something a plugin can subscribe to, and
// there is no session-selected or route-changed event on the bus either: the
// only session events are session.created/updated/deleted/status/idle/error,
// none of which fire when you merely look at a different one. So the only way
// to notice a switch made by something other than this plugin's own command,
// opencode's session picker, a quick-switch slot, child/parent navigation, is
// to sample route.current on a timer.
//
// The one real cost of sampling instead of subscribing: two external switches
// that land closer together than this interval collapse into a single hop,
// and the session in between is skipped rather than becoming `previous`. A
// human picking sessions by hand does not move that fast, so 100ms keeps the
// common case correct while staying cheap: it is one property read and a
// string compare, a hundred times a second at worst.
const POLL_INTERVAL = 100

/* -------------------------------------------------------------------------- */
/* options                                                                     */
/* -------------------------------------------------------------------------- */

type Options = {
  switchKey: string | false
}

const DEFAULTS: Options = {
  switchKey: "ctrl+space",
}

// Copied from sessions-toast's toJumpKey rather than shared, per that file's
// own comment: the distribution convention is "symlink the plugin file", so
// an import between plugins would break it.
export function toSwitchKey(value: unknown, fallback: string | false): string | false {
  if (value === false) return false
  if (typeof value !== "string") return fallback
  const key = value.trim()
  return key ? key : false
}

export function toOptions(raw: Record<string, unknown> | undefined): Options {
  if (!raw) return DEFAULTS
  return {
    switchKey: toSwitchKey(raw.switchKey, DEFAULTS.switchKey),
  }
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

type Level = "debug" | "info" | "warn" | "error"

function log(api: TuiPluginApi, level: Level, message: string, extra?: Record<string, unknown>) {
  // Guarded rather than merely awaited: this is called during plugin init, and
  // a plugin has no business taking the TUI down over a log line.
  try {
    void api.client.app.log({ service: ID, level, message, extra }).catch(() => {})
  } catch {
    // ignored
  }
}

export function sessionIDOf(route: TuiRouteCurrent): string | undefined {
  if (route.name !== "session") return undefined
  const sessionID = route.params?.sessionID
  return typeof sessionID === "string" ? sessionID : undefined
}

/* -------------------------------------------------------------------------- */
/* the switcher                                                                */
/* -------------------------------------------------------------------------- */

// The seam start() takes to control the passage of time, so a test can drive
// the poll interval without waiting on a real one. Defaults to the real
// globals, so the tui() entry point, which calls start() with no argument,
// sees no behaviour change. Narrower than the Clock the other two plugins use:
// this one never needs `now` or a one-shot timeout, only a repeating poll.
export type Clock = {
  setInterval: typeof setInterval
  clearInterval: typeof clearInterval
}

const REAL_CLOCK: Clock = { setInterval, clearInterval }

export function createSwitcher(api: TuiPluginApi) {
  // The two-slot MRU a toggle needs: wherever you are now, and wherever you
  // were before that. Not a longer history, because a longer one raises the
  // question of what a second, third, fourth press should do, and Alt+Tab's
  // whole appeal is that a single key answers that without a dialog. Anyone
  // wanting to pick from further back already has session_list.
  let current: string | undefined
  let previous: string | undefined

  function observe(sessionID: string | undefined) {
    if (sessionID === undefined || sessionID === current) return
    if (current !== undefined) previous = current
    current = sessionID
  }

  function poll() {
    observe(sessionIDOf(api.route.current))
  }

  // Session events are server-wide, not scoped to a project, but that is fine
  // here: a deleted session can only be `current` or `previous` if this TUI
  // had already navigated to it, which means it was already in scope.
  function forget(sessionID: string) {
    if (current === sessionID) {
      current = previous
      previous = undefined
    } else if (previous === sessionID) {
      previous = undefined
    }
  }

  function toggle() {
    // Catches up on a switch this instance made a moment ago, or one the poll
    // interval has not sampled yet: route.navigate() updates the underlying
    // store synchronously, so this sees it immediately rather than waiting up
    // to POLL_INTERVAL for the timer.
    poll()
    const here = sessionIDOf(api.route.current)
    const target = here === current ? previous : current

    if (target === undefined) {
      api.ui.toast({ variant: "info", message: "No previous session to switch to" })
      return
    }
    if (api.state.session.get(target) === undefined) {
      // Belt and braces: forget() should already have caught a deletion via
      // session.deleted, so this is for whatever reason it did not, rather
      // than the expected path. Left uncleaned, a stale target would fail the
      // same way on every press.
      forget(target)
      api.ui.toast({ variant: "info", message: "That session is gone" })
      return
    }
    api.route.navigate("session", { sessionID: target })
  }

  let unsubscribe: Array<() => void> = []
  let poller: ReturnType<typeof setInterval> | undefined
  let clock: Clock = REAL_CLOCK

  // Subscribes to session.deleted and starts the poll interval. Split out of
  // construction so creating a switcher has no side effect: the tui() entry
  // point calls start() right after, so runtime behaviour is unchanged, and a
  // test calls it with a fake clock instead of a real timer.
  function start(seam: Clock = REAL_CLOCK) {
    clock = seam
    unsubscribe = [api.event.on("session.deleted", (event) => forget(event.properties.sessionID))]
    poll()
    poller = clock.setInterval(poll, POLL_INTERVAL)
  }

  function dispose() {
    if (poller !== undefined) clock.clearInterval(poller)
    for (const off of unsubscribe) off()
    unsubscribe = []
  }

  return { toggle, start, dispose }
}

/* -------------------------------------------------------------------------- */
/* entry point                                                                 */
/* -------------------------------------------------------------------------- */

const COMMAND = "sessions-switch.toggle"

const tui: TuiPlugin = async (api, options) => {
  const parsed = toOptions(options)
  const switcher = createSwitcher(api)
  switcher.start()

  // Default-bound rather than opt-in, matching sessions-toast's jumpKey: a
  // plugin's command cannot be bound from config at all, since opencode's
  // keybinds schema is a closed set built from its own command definitions,
  // so there is no entry a user could add themselves. Opt-in would mean the
  // palette and nothing else until someone read the README.
  const bindings = parsed.switchKey
    ? [{ key: parsed.switchKey, cmd: COMMAND, desc: "Toggle to the previous session", group: "Session" }]
    : []

  const unregister = api.keymap.registerLayer({
    commands: [
      {
        namespace: "palette",
        name: COMMAND,
        title: "Switch to the previous session",
        category: "Session",
        run: () => switcher.toggle(),
      },
    ],
    bindings,
  })

  api.lifecycle.onDispose(() => {
    unregister()
    switcher.dispose()
  })

  log(api, "info", "loaded", { switchKey: parsed.switchKey === false ? "disabled" : parsed.switchKey })
}

const plugin: TuiPluginModule & { id: string } = { id: ID, tui }

export default plugin
