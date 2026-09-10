import { afterEach, describe, expect, test } from "bun:test"
import { createSwitcher } from "../sessions-switch.tsx"
import { createFakeApi, createFakeClock } from "./fake-api.ts"
import type { Session } from "@opencode-ai/sdk/v2"

// createSwitcher()'s own state (current/previous) is private; every case here
// is driven the same way the real TUI drives it, through api.route.current
// and the event stream a fake TuiPluginApi captures, and verified through
// fake.navigations and fake.toasts rather than through any exposed internals.

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    slug: id,
    projectID: "prj_1",
    directory: "/tmp/project",
    title: id,
    version: "1",
    time: { created: 0, updated: 0 },
    ...overrides,
  }
}

let disposers: Array<() => void> = []

afterEach(() => {
  for (const dispose of disposers) dispose()
  disposers = []
})

// Mirrors sessions-switch.tsx's own POLL_INTERVAL; not exported, since the
// constant is an implementation detail and the tests only need to advance
// past it, not agree on its exact value.
const POLL_INTERVAL = 100

function start(fake: ReturnType<typeof createFakeApi>) {
  const switcher = createSwitcher(fake.api)
  const { clock, advance } = createFakeClock()
  switcher.start(clock)
  disposers.push(switcher.dispose)
  return { switcher, advance }
}

describe("nothing to switch to yet", () => {
  test("toggling before any switch shows a toast rather than navigating", () => {
    const fake = createFakeApi()
    fake.sessions.set("a", session("a"))
    fake.setRoute({ name: "session", params: { sessionID: "a" } })
    const { switcher } = start(fake)

    switcher.toggle()

    expect(fake.navigations).toEqual([])
    expect(fake.toasts).toHaveLength(1)
    expect(fake.toasts[0]!.message).toBe("No previous session to switch to")
  })
})

describe("the basic toggle", () => {
  test("a switch made by something else is picked up by the poll and toggled back from", () => {
    const fake = createFakeApi()
    fake.sessions.set("a", session("a"))
    fake.sessions.set("b", session("b"))
    fake.setRoute({ name: "session", params: { sessionID: "a" } })
    const { switcher, advance } = start(fake)

    // fake.setRoute stands in for opencode's own session picker, not this
    // plugin's command: the same seam toast-queue.test.ts uses for "you
    // navigated elsewhere".
    fake.setRoute({ name: "session", params: { sessionID: "b" } })
    advance(POLL_INTERVAL)

    switcher.toggle()
    expect(fake.navigations).toEqual([{ name: "session", params: { sessionID: "a" } }])
  })

  test("toggling again bounces back, even faster than the poll interval", () => {
    const fake = createFakeApi()
    fake.sessions.set("a", session("a"))
    fake.sessions.set("b", session("b"))
    fake.setRoute({ name: "session", params: { sessionID: "a" } })
    const { switcher, advance } = start(fake)
    fake.setRoute({ name: "session", params: { sessionID: "b" } })
    advance(POLL_INTERVAL)

    switcher.toggle() // b -> a
    switcher.toggle() // a -> b, with no advance() in between: toggle() polls for itself.

    expect(fake.navigations.map((n) => n.params?.sessionID)).toEqual(["a", "b"])
  })

  test("going home and toggling from there returns to the last session, not the one before it", () => {
    const fake = createFakeApi()
    fake.sessions.set("a", session("a"))
    fake.sessions.set("b", session("b"))
    fake.setRoute({ name: "session", params: { sessionID: "a" } })
    const { switcher, advance } = start(fake)
    fake.setRoute({ name: "session", params: { sessionID: "b" } })
    advance(POLL_INTERVAL)
    fake.setRoute({ name: "home" })
    advance(POLL_INTERVAL)

    switcher.toggle()
    expect(fake.navigations).toEqual([{ name: "session", params: { sessionID: "b" } }])
  })
})

describe("the poll is a sample, not a subscription", () => {
  test("two switches closer together than the poll interval collapse: the middle one is skipped", () => {
    const fake = createFakeApi()
    fake.sessions.set("a", session("a"))
    fake.sessions.set("c", session("c"))
    fake.setRoute({ name: "session", params: { sessionID: "a" } })
    const { switcher } = start(fake)

    // Neither setRoute is followed by advance(): the poll interval never
    // samples "b", and toggle()'s own poll() only ever sees the latest value.
    fake.setRoute({ name: "session", params: { sessionID: "b" } })
    fake.setRoute({ name: "session", params: { sessionID: "c" } })

    switcher.toggle()
    // "b" is never named: it was never sampled, so it was never `previous`.
    expect(fake.navigations).toEqual([{ name: "session", params: { sessionID: "a" } }])
  })
})

describe("a target that no longer exists", () => {
  test("toggling to a session that was never listed shows a toast and does not navigate", () => {
    const fake = createFakeApi()
    fake.sessions.set("b", session("b")) // "a" is deliberately never added
    fake.setRoute({ name: "session", params: { sessionID: "a" } })
    const { switcher, advance } = start(fake)
    fake.setRoute({ name: "session", params: { sessionID: "b" } })
    advance(POLL_INTERVAL)

    switcher.toggle()

    expect(fake.navigations).toEqual([])
    expect(fake.toasts.at(-1)?.message).toBe("That session is gone")
  })

  test("a stale target is forgotten rather than failing the same way on every press", () => {
    const fake = createFakeApi()
    fake.sessions.set("b", session("b")) // "a" is deliberately never added
    fake.setRoute({ name: "session", params: { sessionID: "a" } })
    const { switcher, advance } = start(fake)
    fake.setRoute({ name: "session", params: { sessionID: "b" } })
    advance(POLL_INTERVAL)

    switcher.toggle() // fails on "a", and forgets it
    switcher.toggle() // "a" is no longer offered a second time

    expect(fake.navigations).toEqual([])
    expect(fake.toasts.map((t) => t.message)).toEqual(["That session is gone", "No previous session to switch to"])
  })

  test("a session.deleted event drops it from previous before it is ever offered", () => {
    const fake = createFakeApi()
    fake.sessions.set("a", session("a"))
    fake.sessions.set("b", session("b"))
    fake.setRoute({ name: "session", params: { sessionID: "a" } })
    const { switcher, advance } = start(fake)
    fake.setRoute({ name: "session", params: { sessionID: "b" } })
    advance(POLL_INTERVAL)

    fake.emit({ id: "e", type: "session.deleted", properties: { sessionID: "a", info: session("a") } })
    switcher.toggle()

    expect(fake.navigations).toEqual([])
    expect(fake.toasts.at(-1)?.message).toBe("No previous session to switch to")
  })

  test("a session.deleted event for the session being viewed promotes the previous one", () => {
    const fake = createFakeApi()
    fake.sessions.set("a", session("a"))
    fake.sessions.set("b", session("b"))
    fake.setRoute({ name: "session", params: { sessionID: "a" } })
    const { switcher, advance } = start(fake)
    fake.setRoute({ name: "session", params: { sessionID: "b" } })
    advance(POLL_INTERVAL)

    // "b" is both the one currently being viewed and the one that vanishes.
    fake.emit({ id: "e", type: "session.deleted", properties: { sessionID: "b", info: session("b") } })
    switcher.toggle()

    expect(fake.navigations).toEqual([{ name: "session", params: { sessionID: "a" } }])
  })
})
