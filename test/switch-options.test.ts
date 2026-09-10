import { describe, expect, test } from "bun:test"
import { sessionIDOf, toOptions, toSwitchKey } from "../sessions-switch.tsx"

describe("toSwitchKey", () => {
  test("keeps false as-is", () => {
    expect(toSwitchKey(false, "ctrl+space")).toBe(false)
  })

  test("falls back on a non-string", () => {
    expect(toSwitchKey(42, "ctrl+space")).toBe("ctrl+space")
  })

  test("trims and keeps a non-empty string", () => {
    expect(toSwitchKey("  ctrl+shift+space  ", "ctrl+space")).toBe("ctrl+shift+space")
  })

  test("treats a blank string as false", () => {
    expect(toSwitchKey("   ", "ctrl+space")).toBe(false)
  })
})

describe("toOptions", () => {
  test("defaults to ctrl+space when raw is undefined", () => {
    expect(toOptions(undefined).switchKey).toBe("ctrl+space")
  })

  test("reads switchKey from raw", () => {
    expect(toOptions({ switchKey: "f9" }).switchKey).toBe("f9")
    expect(toOptions({ switchKey: false }).switchKey).toBe(false)
  })
})

describe("sessionIDOf", () => {
  test("reads the sessionID off a session route", () => {
    expect(sessionIDOf({ name: "session", params: { sessionID: "ses_a" } })).toBe("ses_a")
  })

  test("is undefined for home", () => {
    expect(sessionIDOf({ name: "home" })).toBeUndefined()
  })

  test("is undefined for another plugin's route, even one that happens to carry a sessionID param", () => {
    expect(sessionIDOf({ name: "diff-viewer", params: { sessionID: "ses_a" } })).toBeUndefined()
  })
})
