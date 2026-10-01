import { describe, expect, test } from "bun:test"
import { normalizeTodos, oneLine, progressText, summarize, toOptions } from "../sessions-sidebar.tsx"

function todos(...statuses: string[]) {
  return statuses.map((status, index) => ({ content: `item ${index + 1}`, status }))
}

describe("showProgress", () => {
  test("is on unless switched off", () => {
    expect(toOptions(undefined).showProgress).toBe(true)
    expect(toOptions({}).showProgress).toBe(true)
    expect(toOptions({ showProgress: false }).showProgress).toBe(false)
  })

  test("falls back on a value that is not a boolean", () => {
    expect(toOptions({ showProgress: "no" }).showProgress).toBe(true)
    expect(toOptions({ showProgress: 0 }).showProgress).toBe(true)
  })
})

describe("oneLine", () => {
  test("collapses whitespace and newlines into single spaces", () => {
    expect(oneLine("  Add\ttoken\n\n  columns \r\n")).toBe("Add token columns")
  })
})

describe("normalizeTodos", () => {
  test("keeps content and status, dropping the rest", () => {
    expect(normalizeTodos([{ content: "a", status: "pending", priority: "high", id: "x" }])).toEqual([
      { content: "a", status: "pending" },
    ])
  })

  test("accepts an empty list", () => {
    expect(normalizeTodos([])).toEqual([])
  })

  test("rejects anything that is not a list", () => {
    expect(normalizeTodos(undefined)).toBeUndefined()
    expect(normalizeTodos(null)).toBeUndefined()
    expect(normalizeTodos({ todos: [] })).toBeUndefined()
    expect(normalizeTodos("[]")).toBeUndefined()
  })

  test("rejects a list holding something that is not an object", () => {
    expect(normalizeTodos([{ content: "a", status: "pending" }, "b"])).toBeUndefined()
    expect(normalizeTodos([null])).toBeUndefined()
  })

  test("tolerates missing or mistyped fields", () => {
    expect(normalizeTodos([{}, { content: 3, status: 4 }])).toEqual([
      { content: "", status: "unknown" },
      { content: "", status: "unknown" },
    ])
  })
})

describe("summarize", () => {
  test("counts all pending items as none done", () => {
    const summary = summarize(todos("pending", "pending"))
    expect(summary).toMatchObject({ completed: 0, total: 2, cancelled: 0, percent: 0, current: null })
  })

  test("reaches 100% only when everything is completed", () => {
    expect(summarize(todos("completed", "completed")).percent).toBe(100)
    expect(summarize(todos("completed", "completed", "pending")).percent).toBe(66)
  })

  test("does not count cancelled items as completed or as outstanding", () => {
    const summary = summarize(todos("completed", "cancelled", "cancelled", "pending"))
    expect(summary).toMatchObject({ completed: 1, total: 2, cancelled: 2, percent: 50 })
  })

  test("a list completed except for cancelled items reads 100%", () => {
    expect(summarize(todos("completed", "cancelled")).percent).toBe(100)
  })

  test("an all-cancelled list has nothing to measure", () => {
    const summary = summarize(todos("cancelled", "cancelled"))
    expect(summary).toMatchObject({ completed: 0, total: 0, cancelled: 2, percent: null, current: null })
  })

  test("an empty list has nothing to measure", () => {
    expect(summarize([])).toMatchObject({ completed: 0, total: 0, cancelled: 0, percent: null })
  })

  test("the current item is the first in_progress one, in list order", () => {
    const summary = summarize([
      { content: "done", status: "completed" },
      { content: "later", status: "pending" },
      { content: "first", status: "in_progress" },
      { content: "second", status: "in_progress" },
      { content: "third", status: "in_progress" },
    ])
    expect(summary.current).toBe("first")
    expect(summary.additionalInProgress).toBe(2)
  })

  test("a pending item is not presented as the current one", () => {
    expect(summarize(todos("completed", "pending")).current).toBeNull()
  })

  test("an unknown status stays in the total without being completed", () => {
    expect(summarize(todos("completed", "blocked"))).toMatchObject({ completed: 1, total: 2, percent: 50 })
  })

  test("multiline content is shown on one line", () => {
    const summary = summarize([{ content: "Add\n  token\tcolumns", status: "in_progress" }])
    expect(summary.current).toBe("Add token columns")
  })
})

describe("progressText", () => {
  test("shows the counts, the percentage and the current item", () => {
    const summary = summarize([
      ...todos("completed", "completed", "completed"),
      { content: "Add token columns", status: "in_progress" },
      ...todos("pending", "pending", "pending", "pending"),
    ])
    expect(progressText(summary)).toBe("3/8 (37%) now: Add token columns")
  })

  test("says there is none when nothing is in progress", () => {
    expect(progressText(summarize(todos("completed", "pending")))).toBe("1/2 (50%) now: none")
  })

  test("mentions the extra items in progress", () => {
    expect(progressText(summarize(todos("in_progress", "in_progress", "in_progress")))).toBe(
      "0/3 (0%) now: item 1 (+2 more)",
    )
  })

  describe("with a format", () => {
    const summary = summarize([
      ...todos("completed", "completed", "completed"),
      { content: "Add token columns", status: "in_progress" },
      { content: "Second", status: "in_progress" },
      ...todos("pending", "pending", "pending"),
    ])

    test.each([
      ["{done}/{total} {percent}% now: {now}", "3/8 37% now: Add token columns"],
      ["{done}/{total} {now}{more}", "3/8 Add token columns (+1 more)"],
      ["{done}/{total}", "3/8"],
      ["{percent}", "37"],
      ["now: {now}", "now: Add token columns"],
      ["{done} {done}", "3 3"],
    ])("expands %s", (format, expected) => {
      expect(progressText(summary, format)).toBe(expected)
    })

    test("leaves out {more} when there is nothing more", () => {
      expect(progressText(summarize(todos("in_progress")), "{now}{more}")).toBe("item 1")
    })

    test("leaves anything that is not a placeholder as typed", () => {
      expect(progressText(summary, "{done} of {totl} {Now} {}")).toBe("3 of {totl} {Now} {}")
    })

    test("does not expand a placeholder written in a todo", () => {
      const tricky = summarize([{ content: "fix {done} and {total}", status: "in_progress" }])
      expect(progressText(tricky, "{now}")).toBe("fix {done} and {total}")
    })

    test("is kept to one line", () => {
      expect(progressText(summary, "{done}/{total}\n  now: {now}")).toBe("3/8 now: Add token columns")
    })
  })
})

describe("progressFormat", () => {
  test("defaults to the percentage in parentheses without a comma", () => {
    expect(toOptions(undefined).progressFormat).toBe("{done}/{total} ({percent}%) now: {now}{more}")
  })

  test("takes a string as given", () => {
    expect(toOptions({ progressFormat: "{done}/{total}" }).progressFormat).toBe("{done}/{total}")
  })

  test("falls back on a value that is not a string, or is blank", () => {
    const fallback = toOptions(undefined).progressFormat
    expect(toOptions({ progressFormat: 3 }).progressFormat).toBe(fallback)
    expect(toOptions({ progressFormat: null }).progressFormat).toBe(fallback)
    expect(toOptions({ progressFormat: "  " }).progressFormat).toBe(fallback)
    expect(toOptions({ progressFormat: "" }).progressFormat).toBe(fallback)
  })
})
