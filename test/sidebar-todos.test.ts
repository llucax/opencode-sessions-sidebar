import { afterEach, describe, expect, test } from "bun:test"
import { createModel, toOptions } from "../sessions-sidebar.tsx"
import { createFakeApi, createFakeClock, flush } from "./fake-api.ts"
import type { Session } from "@opencode-ai/sdk/v2"

// The model's todo handling is reached the way the TUI reaches it: the panel
// tells it which sessions are on screen through setVisible(), the endpoint
// answers through the fake api, and todo.updated arrives on the event stream.

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    slug: id,
    projectID: "prj_1",
    directory: "/tmp/project",
    title: `Session ${id}`,
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

async function start(fake: ReturnType<typeof createFakeApi>, options?: Record<string, unknown>) {
  const model = createModel(fake.api, toOptions(options))
  const time = createFakeClock()
  model.start(time.clock)
  disposers.push(model.dispose)
  await flush()
  return { model, ...time }
}

function todo(content: string, status: string) {
  return { content, status, priority: "medium" }
}

function updated(sessionID: string, todos: unknown[]) {
  return { id: "e", type: "todo.updated", properties: { sessionID, todos } } as never
}

const OWNER = Symbol("panel")

// A request the test answers itself, so it can decide the order of events.
function held(fake: ReturnType<typeof createFakeApi>) {
  const waiting = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  fake.todoRequests.handler = (call) =>
    new Promise((resolve, reject) => {
      waiting.set(call.sessionID, { resolve, reject })
    })
  return waiting
}

describe("fetching", () => {
  test("asks for nothing until a session is shown", async () => {
    const fake = createFakeApi()
    fake.responses.sessionList = [session("a")]
    const { model } = await start(fake)
    await flush()
    expect(fake.todoCalls).toEqual([])
    expect(model.progressOf("a")).toEqual({ kind: "none" })
  })

  test("fetches a session shown, with the directory of that session", async () => {
    const fake = createFakeApi()
    fake.responses.sessionList = [session("a"), session("b", { directory: "/tmp/elsewhere" })]
    fake.responses.todos = { a: [todo("x", "pending")], b: [todo("y", "pending")] }
    const { model } = await start(fake)

    model.setVisible(OWNER, ["a", "b"])
    await flush()

    expect(fake.todoCalls).toEqual([
      { sessionID: "a", directory: "/tmp/project" },
      { sessionID: "b", directory: "/tmp/elsewhere" },
    ])
  })

  test("summarises the list it gets", async () => {
    const fake = createFakeApi()
    fake.responses.sessionList = [session("a")]
    fake.responses.todos = {
      a: [todo("one", "completed"), todo("two", "in_progress"), todo("three", "pending"), todo("four", "cancelled")],
    }
    const { model } = await start(fake)

    model.setVisible(OWNER, ["a"])
    await flush()

    const progress = model.progressOf("a")
    expect(progress.kind).toBe("summary")
    if (progress.kind === "summary") {
      expect(progress.stale).toBe(false)
      expect(progress.summary).toMatchObject({ completed: 1, total: 3, cancelled: 1, percent: 33, current: "two" })
    }
  })

  test("an empty list and an all-cancelled list count as no todo", async () => {
    const fake = createFakeApi()
    fake.responses.sessionList = [session("empty"), session("cancelled")]
    fake.responses.todos = { empty: [], cancelled: [todo("x", "cancelled"), todo("y", "cancelled")] }
    const { model } = await start(fake)

    model.setVisible(OWNER, ["empty", "cancelled"])
    await flush()

    expect(model.progressOf("empty")).toEqual({ kind: "none" })
    expect(model.progressOf("cancelled")).toEqual({ kind: "none" })
  })

  test("keeps the original row until the first answer arrives", async () => {
    const fake = createFakeApi()
    fake.responses.sessionList = [session("a")]
    const waiting = held(fake)
    const { model } = await start(fake)

    model.setVisible(OWNER, ["a"])
    await flush()
    expect(model.progressOf("a")).toEqual({ kind: "none" })

    waiting.get("a")!.resolve([todo("x", "pending")])
    await flush()
    expect(model.progressOf("a").kind).toBe("summary")
  })

  test("fetches only what was not shown before, and only once at a time", async () => {
    const fake = createFakeApi()
    fake.responses.sessionList = [session("a"), session("b")]
    const waiting = held(fake)
    const { model } = await start(fake)

    model.setVisible(OWNER, ["a"])
    model.setVisible(OWNER, ["a"])
    model.setVisible(OWNER, ["a", "b"])
    await flush()
    expect(fake.todoCalls.map((call) => call.sessionID)).toEqual(["a", "b"])

    waiting.get("a")!.resolve([])
    waiting.get("b")!.resolve([])
    await flush()
    model.setVisible(OWNER, ["b"])
    model.setVisible(OWNER, ["a", "b"])
    await flush()
    // "a" was shown again after being hidden, so it is fetched again.
    expect(fake.todoCalls.map((call) => call.sessionID)).toEqual(["a", "b", "a"])
  })

  test("never has more than four requests in flight", async () => {
    const fake = createFakeApi()
    const ids = Array.from({ length: 10 }, (_, index) => `s${index}`)
    fake.responses.sessionList = ids.map((id) => session(id))
    const waiting = held(fake)
    const { model } = await start(fake)

    model.setVisible(OWNER, ids)
    await flush()
    expect(waiting.size).toBe(4)

    // Every answer frees a slot for the next session in line.
    for (let round = 0; round < 10 && fake.todoCalls.length < 10; round++) {
      for (const [id, request] of [...waiting]) {
        waiting.delete(id)
        request.resolve([todo("x", "pending")])
      }
      await flush()
    }
    expect(fake.todoCalls.map((call) => call.sessionID).sort()).toEqual([...ids].sort())
    expect(fake.todosPeak()).toBe(4)
  })

  test("a session shown by two panels is fetched on appearing and kept by either", async () => {
    const fake = createFakeApi()
    fake.responses.sessionList = [session("a"), session("b")]
    const { model, advance } = await start(fake)
    const other = Symbol("other")

    model.setVisible(OWNER, ["a"])
    model.setVisible(other, ["b"])
    await flush()
    expect(fake.todoCalls.map((call) => call.sessionID)).toEqual(["a", "b"])

    // Hiding one panel's sessions does not hide the other's.
    model.setVisible(OWNER, [])
    advance(30_000)
    await flush()
    expect(fake.todoCalls.slice(2).map((call) => call.sessionID)).toEqual(["b"])
  })
})

describe("events", () => {
  test("todo.updated replaces the list at once", async () => {
    const fake = createFakeApi()
    fake.responses.sessionList = [session("a")]
    fake.responses.todos = { a: [todo("x", "pending")] }
    const { model } = await start(fake)
    model.setVisible(OWNER, ["a"])
    await flush()

    fake.emit(updated("a", [todo("x", "completed"), todo("y", "in_progress")]))

    const progress = model.progressOf("a")
    expect(progress.kind === "summary" && progress.summary).toMatchObject({ completed: 1, total: 2, current: "y" })
  })

  test("an event for a session that is not shown still updates the cache", async () => {
    const fake = createFakeApi()
    fake.responses.sessionList = [session("a")]
    const { model } = await start(fake)

    fake.emit(updated("a", [todo("x", "pending")]))

    expect(model.progressOf("a").kind).toBe("summary")
    expect(fake.todoCalls).toEqual([])
  })

  test("ignores a session of another project", async () => {
    const fake = createFakeApi()
    fake.responses.sessionList = [session("a")]
    const { model } = await start(fake)

    fake.emit(updated("foreign", [todo("x", "pending")]))

    expect(model.progressOf("foreign")).toEqual({ kind: "none" })
  })

  test("an event that empties the list returns the row to one line", async () => {
    const fake = createFakeApi()
    fake.responses.sessionList = [session("a")]
    fake.responses.todos = { a: [todo("x", "pending")] }
    const { model } = await start(fake)
    model.setVisible(OWNER, ["a"])
    await flush()
    expect(model.progressOf("a").kind).toBe("summary")

    fake.emit(updated("a", [todo("x", "cancelled")]))

    expect(model.progressOf("a")).toEqual({ kind: "none" })
  })

  test("a malformed event is ignored", async () => {
    const fake = createFakeApi()
    fake.responses.sessionList = [session("a")]
    fake.responses.todos = { a: [todo("x", "pending")] }
    const { model } = await start(fake)
    model.setVisible(OWNER, ["a"])
    await flush()

    fake.emit(updated("a", "nonsense" as never))

    expect(model.progressOf("a").kind).toBe("summary")
  })

  test("an answer to a fetch that began before an event does not overwrite it", async () => {
    const fake = createFakeApi()
    fake.responses.sessionList = [session("a")]
    const waiting = held(fake)
    const { model } = await start(fake)
    model.setVisible(OWNER, ["a"])
    await flush()

    fake.emit(updated("a", [todo("new", "in_progress")]))
    waiting.get("a")!.resolve([todo("old", "pending")])
    await flush()

    const progress = model.progressOf("a")
    expect(progress.kind === "summary" && progress.summary.current).toBe("new")
  })

  test("a failure that began before an event does not mark its list stale", async () => {
    const fake = createFakeApi()
    fake.responses.sessionList = [session("a")]
    const waiting = held(fake)
    const { model } = await start(fake)
    model.setVisible(OWNER, ["a"])
    await flush()

    fake.emit(updated("a", [todo("new", "in_progress")]))
    waiting.get("a")!.reject(new Error("boom"))
    await flush()

    const progress = model.progressOf("a")
    expect(progress.kind === "summary" && progress.stale).toBe(false)
  })
})

describe("resync", () => {
  test("repairs a missed event for what is shown", async () => {
    const fake = createFakeApi()
    fake.responses.sessionList = [session("a")]
    fake.responses.todos = { a: [todo("x", "pending")] }
    const { model, advance } = await start(fake)
    model.setVisible(OWNER, ["a"])
    await flush()

    fake.responses.todos = { a: [todo("x", "completed")] }
    advance(30_000)
    await flush()

    const progress = model.progressOf("a")
    expect(progress.kind === "summary" && progress.summary.percent).toBe(100)
  })

  test("does not fetch what is not shown", async () => {
    const fake = createFakeApi()
    fake.responses.sessionList = [session("a"), session("b")]
    const { model, advance } = await start(fake)
    model.setVisible(OWNER, ["a"])
    await flush()

    advance(30_000)
    await flush()

    expect(fake.todoCalls.map((call) => call.sessionID)).toEqual(["a", "a"])
    expect(model.progressOf("b")).toEqual({ kind: "none" })
  })

  test("does not stack a request on one still in flight", async () => {
    const fake = createFakeApi()
    fake.responses.sessionList = [session("a")]
    held(fake)
    const { model, advance } = await start(fake)
    model.setVisible(OWNER, ["a"])
    await flush()

    advance(90_000)
    await flush()

    expect(fake.todoCalls).toHaveLength(1)
  })

  test("drops what it knows of a session the server no longer lists", async () => {
    const fake = createFakeApi()
    fake.responses.sessionList = [session("a")]
    fake.responses.todos = { a: [todo("x", "pending")] }
    const { model, advance } = await start(fake)
    model.setVisible(OWNER, ["a"])
    await flush()
    expect(model.progressOf("a").kind).toBe("summary")

    fake.responses.sessionList = []
    advance(30_000)
    await flush()

    expect(model.progressOf("a")).toEqual({ kind: "none" })
  })
})

describe("failures", () => {
  test("with nothing known, the progress is unavailable", async () => {
    const fake = createFakeApi()
    fake.responses.sessionList = [session("a")]
    fake.todoRequests.handler = async () => {
      throw new Error("boom")
    }
    const { model } = await start(fake)

    model.setVisible(OWNER, ["a"])
    await flush()

    expect(model.progressOf("a")).toEqual({ kind: "unavailable" })
    // And the failure is logged without the todos, which are not its business.
    expect(fake.logs.some((log) => log.message === "failed to fetch todos")).toBe(true)
  })

  test("with a list known, it is kept and marked stale until the next answer", async () => {
    const fake = createFakeApi()
    fake.responses.sessionList = [session("a")]
    fake.responses.todos = { a: [todo("x", "pending")] }
    const { model, advance } = await start(fake)
    model.setVisible(OWNER, ["a"])
    await flush()

    fake.todoRequests.handler = async () => {
      throw new Error("boom")
    }
    advance(30_000)
    await flush()
    const stale = model.progressOf("a")
    expect(stale.kind === "summary" && stale.stale).toBe(true)
    expect(stale.kind === "summary" && stale.summary.total).toBe(1)

    fake.todoRequests.handler = async () => [todo("x", "completed")]
    advance(30_000)
    await flush()
    const fresh = model.progressOf("a")
    expect(fresh.kind === "summary" && fresh.stale).toBe(false)
  })

  test("an event clears the stale marker", async () => {
    const fake = createFakeApi()
    fake.responses.sessionList = [session("a")]
    fake.responses.todos = { a: [todo("x", "pending")] }
    const { model, advance } = await start(fake)
    model.setVisible(OWNER, ["a"])
    await flush()
    fake.todoRequests.handler = async () => {
      throw new Error("boom")
    }
    advance(30_000)
    await flush()

    fake.emit(updated("a", [todo("x", "completed")]))

    const progress = model.progressOf("a")
    expect(progress.kind === "summary" && progress.stale).toBe(false)
  })

  test("a malformed answer is a failure and erases nothing", async () => {
    const fake = createFakeApi()
    fake.responses.sessionList = [session("a")]
    fake.responses.todos = { a: [todo("x", "pending")] }
    const { model, advance } = await start(fake)
    model.setVisible(OWNER, ["a"])
    await flush()

    fake.responses.todos = { a: { not: "a list" } }
    advance(30_000)
    await flush()

    const progress = model.progressOf("a")
    expect(progress.kind === "summary" && progress.stale).toBe(true)
  })

  test("one session failing does not affect another", async () => {
    const fake = createFakeApi()
    fake.responses.sessionList = [session("a"), session("b")]
    fake.responses.todos = { b: [todo("x", "pending")] }
    fake.todoRequests.handler = async (call) => {
      if (call.sessionID === "a") throw new Error("boom")
      return fake.responses.todos[call.sessionID]
    }
    const { model } = await start(fake)

    model.setVisible(OWNER, ["a", "b"])
    await flush()

    expect(model.progressOf("a")).toEqual({ kind: "unavailable" })
    expect(model.progressOf("b").kind).toBe("summary")
  })
})

describe("deletion and disposal", () => {
  test("deleting a session purges its entry and ignores a late answer", async () => {
    const fake = createFakeApi()
    fake.responses.sessionList = [session("a"), session("b")]
    fake.responses.todos = { a: [todo("x", "pending")] }
    const { model } = await start(fake)
    model.setVisible(OWNER, ["a"])
    await flush()
    expect(model.progressOf("a").kind).toBe("summary")

    fake.emit({ id: "e", type: "session.deleted", properties: { sessionID: "a", info: session("a") } })
    expect(model.progressOf("a")).toEqual({ kind: "none" })

    const waiting = held(fake)
    model.setVisible(OWNER, ["b"])
    await flush()
    fake.emit({ id: "e", type: "session.deleted", properties: { sessionID: "b", info: session("b") } })
    waiting.get("b")!.resolve([todo("x", "pending")])
    await flush()
    expect(model.progressOf("b")).toEqual({ kind: "none" })
  })

  test("after disposal answers are ignored and events no longer arrive", async () => {
    const fake = createFakeApi()
    fake.responses.sessionList = [session("a")]
    const waiting = held(fake)
    const { model } = await start(fake)
    model.setVisible(OWNER, ["a"])
    await flush()

    model.dispose()
    waiting.get("a")!.resolve([todo("x", "pending")])
    await flush()
    expect(model.progressOf("a")).toEqual({ kind: "none" })

    fake.emit(updated("a", [todo("x", "pending")]))
    expect(model.progressOf("a")).toEqual({ kind: "none" })

    model.setVisible(OWNER, ["a"])
    await flush()
    expect(fake.todoCalls).toHaveLength(1)
  })
})

describe("showProgress off", () => {
  test("neither fetches nor listens", async () => {
    const fake = createFakeApi()
    fake.responses.sessionList = [session("a")]
    fake.responses.todos = { a: [todo("x", "pending")] }
    const { model, advance } = await start(fake, { showProgress: false })

    model.setVisible(OWNER, ["a"])
    fake.emit(updated("a", [todo("x", "pending")]))
    advance(30_000)
    await flush()

    expect(fake.todoCalls).toEqual([])
    expect(model.progressOf("a")).toEqual({ kind: "none" })
  })
})
