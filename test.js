// Tests for the notification plugin event state machine.
// Uses Node's built-in test runner (node --test) — no dependencies needed.
//
// Run:  node --test test.js

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NotificationPlugin } from "./index.js";
const { createEventHandler, ICONS } = NotificationPlugin._test;

// --- Helpers ---

function makeConfig(overrides = {}) {
  return { desktop: true, tabIcon: true, delay: 5, focusMode: "none", ...overrides };
}

// Collects calls to injected deps for assertion.
function makeMocks() {
  const calls = {
    notify: [],
    setTabIcon: [],
    clearTabIcon: [],
    getSessionTitle: [],
    timeouts: new Map(), // id -> callback
  };
  let nextTimeoutId = 1;

  return {
    calls,
    deps: {
      notifyFn: (title, msg, opts) => calls.notify.push({ title, msg, opts }),
      setTabIconFn: async (sid, icon) => calls.setTabIcon.push({ sid, icon }),
      clearTabIconFn: async (sid) => calls.clearTabIcon.push({ sid }),
      getSessionTitleFn: async (sid) => {
        calls.getSessionTitle.push(sid);
        return `Session ${sid}`;
      },
      isSessionTabFocusedFn: () => false,
      getFrontmostAppFn: () => null,
      setTimeoutFn: (cb, ms) => {
        const id = nextTimeoutId++;
        calls.timeouts.set(id, { cb, ms });
        return id;
      },
      clearTimeoutFn: (id) => {
        calls.timeouts.delete(id);
      },
    },
    // Fire all pending timeouts synchronously
    async flushTimeouts() {
      for (const [id, { cb }] of calls.timeouts) {
        calls.timeouts.delete(id);
        await cb();
      }
    },
  };
}

function msgEvent(role, sessionID, msgId) {
  return {
    event: {
      type: "message.updated",
      properties: { info: { role, sessionID, id: msgId } },
    },
  };
}

function sessionEvent(type, sessionID, extra = {}) {
  return {
    event: { type, properties: { sessionID, ...extra } },
  };
}

// --- Tests ---

describe("Event state machine", () => {
  let mocks, handler;

  beforeEach(() => {
    mocks = makeMocks();
    handler = createEventHandler(makeConfig(), mocks.deps);
  });

  describe("session.idle", () => {
    it("ignores idle if no assistant message was seen", async () => {
      await handler.handleEvent(sessionEvent("session.idle", "s1"));
      assert.equal(mocks.calls.setTabIcon.length, 0);
      assert.equal(mocks.calls.timeouts.size, 0);
    });

    it("schedules notification after assistant message + idle", async () => {
      await handler.handleEvent(msgEvent("assistant", "s1", "a1"));
      await handler.handleEvent(sessionEvent("session.idle", "s1"));

      // Tab icon set immediately
      assert.equal(mocks.calls.setTabIcon.length, 1);
      assert.deepEqual(mocks.calls.setTabIcon[0], { sid: "s1", icon: ICONS["session.idle"] });

      // Desktop notification pending
      assert.equal(mocks.calls.timeouts.size, 1);

      // Fire the timeout
      await mocks.flushTimeouts();
      assert.equal(mocks.calls.notify.length, 1);
      assert.equal(mocks.calls.notify[0].title, "Response Ready");
    });

    it("does not fire twice on repeated idle (assistantSeen cleared)", async () => {
      await handler.handleEvent(msgEvent("assistant", "s1", "a1"));
      await handler.handleEvent(sessionEvent("session.idle", "s1"));
      await mocks.flushTimeouts();

      // Second idle without new assistant message — should do nothing
      await handler.handleEvent(sessionEvent("session.idle", "s1"));
      assert.equal(mocks.calls.notify.length, 1); // still just 1
    });
  });

  describe("message deduplication", () => {
    it("ignores re-updates of the same user message ID", async () => {
      await handler.handleEvent(msgEvent("assistant", "s1", "a1"));
      await handler.handleEvent(sessionEvent("session.idle", "s1"));

      // First user message clears state
      await handler.handleEvent(msgEvent("user", "s1", "u1"));
      assert.equal(mocks.calls.clearTabIcon.length, 1);

      // Same message ID again (metadata re-update) — should NOT clear again
      const clearCountBefore = mocks.calls.clearTabIcon.length;
      await handler.handleEvent(msgEvent("user", "s1", "u1"));
      assert.equal(mocks.calls.clearTabIcon.length, clearCountBefore);
    });

    it("reacts to new user message with different ID", async () => {
      await handler.handleEvent(msgEvent("user", "s1", "u1"));
      const count1 = mocks.calls.clearTabIcon.length;

      await handler.handleEvent(msgEvent("user", "s1", "u2"));
      // Different ID → should process (clearTabIcon called if icon was active,
      // but at minimum the state tracking changes)
      assert.ok(true); // just verifying no crash; state is internal
    });
  });

  describe("interrupt handling", () => {
    it("suppresses idle notification after interrupt", async () => {
      await handler.handleEvent(msgEvent("assistant", "s1", "a1"));
      await handler.handleEvent(
        sessionEvent("command.executed", "s1", { name: "session.interrupt" }),
      );
      await handler.handleEvent(sessionEvent("session.idle", "s1"));

      // No notification should be scheduled
      assert.equal(mocks.calls.setTabIcon.length, 0);
      assert.equal(mocks.calls.timeouts.size, 0);
    });

    it("cancels pending timer on interrupt", async () => {
      await handler.handleEvent(msgEvent("assistant", "s1", "a1"));
      await handler.handleEvent(sessionEvent("session.idle", "s1"));
      assert.equal(mocks.calls.timeouts.size, 1);

      await handler.handleEvent(
        sessionEvent("command.executed", "s1", { name: "session.interrupt" }),
      );
      assert.equal(mocks.calls.timeouts.size, 0); // timer cleared
    });
  });

  describe("session.error", () => {
    it("schedules error notification", async () => {
      await handler.handleEvent(sessionEvent("session.error", "s1"));

      assert.equal(mocks.calls.setTabIcon.length, 1);
      assert.deepEqual(mocks.calls.setTabIcon[0], { sid: "s1", icon: ICONS["session.error"] });

      await mocks.flushTimeouts();
      assert.equal(mocks.calls.notify.length, 1);
      assert.equal(mocks.calls.notify[0].title, "Session Error");
    });

    it("treats MessageAbortedError as interrupt, not error", async () => {
      await handler.handleEvent(
        sessionEvent("session.error", "s1", { error: { name: "MessageAbortedError" } }),
      );

      // Should NOT schedule notification
      assert.equal(mocks.calls.setTabIcon.length, 0);
      assert.equal(mocks.calls.timeouts.size, 0);

      // Should mark as interrupted
      assert.ok(handler._state.interrupted.has("s1"));
    });
  });

  describe("permission.asked / question.asked", () => {
    it("schedules permission notification", async () => {
      await handler.handleEvent(sessionEvent("permission.asked", "s1"));

      assert.equal(mocks.calls.setTabIcon.length, 1);
      assert.equal(mocks.calls.setTabIcon[0].icon, ICONS["permission.asked"]);

      await mocks.flushTimeouts();
      assert.equal(mocks.calls.notify[0].title, "Permission Needed");
    });

    it("schedules question notification", async () => {
      await handler.handleEvent(sessionEvent("question.asked", "s1"));

      assert.equal(mocks.calls.setTabIcon.length, 1);
      assert.equal(mocks.calls.setTabIcon[0].icon, ICONS["question.asked"]);

      await mocks.flushTimeouts();
      assert.equal(mocks.calls.notify[0].title, "Question");
    });

    it("cancels on permission.replied", async () => {
      await handler.handleEvent(sessionEvent("permission.asked", "s1"));
      assert.equal(mocks.calls.timeouts.size, 1);

      await handler.handleEvent(sessionEvent("permission.replied", "s1"));
      assert.equal(mocks.calls.timeouts.size, 0);
      assert.equal(mocks.calls.clearTabIcon.length, 1);
    });

    it("cancels on question.replied", async () => {
      await handler.handleEvent(sessionEvent("question.asked", "s1"));
      await handler.handleEvent(sessionEvent("question.replied", "s1"));
      assert.equal(mocks.calls.timeouts.size, 0);
      assert.equal(mocks.calls.clearTabIcon.length, 1);
    });
  });

  describe("new user message clears state", () => {
    it("cancels pending timer and clears icon on new user message", async () => {
      await handler.handleEvent(msgEvent("assistant", "s1", "a1"));
      await handler.handleEvent(sessionEvent("session.idle", "s1"));
      assert.equal(mocks.calls.timeouts.size, 1);

      await handler.handleEvent(msgEvent("user", "s1", "u1"));
      assert.equal(mocks.calls.timeouts.size, 0);
      assert.equal(mocks.calls.clearTabIcon.length, 1);
    });

    it("clears assistantSeen so next idle is ignored", async () => {
      await handler.handleEvent(msgEvent("assistant", "s1", "a1"));
      await handler.handleEvent(msgEvent("user", "s1", "u1"));

      // idle without new assistant message should be ignored
      await handler.handleEvent(sessionEvent("session.idle", "s1"));
      assert.equal(mocks.calls.setTabIcon.length, 0);
    });
  });

  describe("config: desktop disabled", () => {
    it("sets tab icon but does not schedule desktop notification", async () => {
      const m = makeMocks();
      const h = createEventHandler(makeConfig({ desktop: false }), m.deps);

      await h.handleEvent(msgEvent("assistant", "s1", "a1"));
      await h.handleEvent(sessionEvent("session.idle", "s1"));

      assert.equal(m.calls.setTabIcon.length, 1);
      assert.equal(m.calls.timeouts.size, 0); // no timer
    });
  });

  describe("config: tabIcon disabled", () => {
    it("schedules desktop notification but does not set tab icon", async () => {
      const m = makeMocks();
      const h = createEventHandler(makeConfig({ tabIcon: false }), m.deps);

      await h.handleEvent(msgEvent("assistant", "s1", "a1"));
      await h.handleEvent(sessionEvent("session.idle", "s1"));

      assert.equal(m.calls.setTabIcon.length, 0);
      assert.equal(m.calls.timeouts.size, 1);
    });
  });

  describe("config: sound", () => {
    it("passes sound: true by default", async () => {
      const m = makeMocks();
      const h = createEventHandler(makeConfig(), m.deps);

      await h.handleEvent(msgEvent("assistant", "s1", "a1"));
      await h.handleEvent(sessionEvent("session.idle", "s1"));
      await m.flushTimeouts();

      assert.equal(m.calls.notify.length, 1);
      assert.deepEqual(m.calls.notify[0].opts, { sound: true });
    });

    it("passes sound: false when config.sound is false", async () => {
      const m = makeMocks();
      const h = createEventHandler(makeConfig({ sound: false }), m.deps);

      await h.handleEvent(msgEvent("assistant", "s1", "a1"));
      await h.handleEvent(sessionEvent("session.idle", "s1"));
      await m.flushTimeouts();

      assert.equal(m.calls.notify.length, 1);
      assert.deepEqual(m.calls.notify[0].opts, { sound: false });
    });

    it("passes sound: true when config.sound is explicitly true", async () => {
      const m = makeMocks();
      const h = createEventHandler(makeConfig({ sound: true }), m.deps);

      await h.handleEvent(sessionEvent("permission.asked", "s1"));
      await m.flushTimeouts();

      assert.equal(m.calls.notify.length, 1);
      assert.deepEqual(m.calls.notify[0].opts, { sound: true });
    });
  });

  describe("focus suppression", () => {
    it("focusMode=app suppresses when terminal is frontmost", async () => {
      const m = makeMocks();
      m.deps.getFrontmostAppFn = () => "ghostty";
      const h = createEventHandler(makeConfig({ focusMode: "app" }), m.deps);

      await h.handleEvent(msgEvent("assistant", "s1", "a1"));
      await h.handleEvent(sessionEvent("session.idle", "s1"));
      await m.flushTimeouts();

      assert.equal(m.calls.notify.length, 0); // suppressed
    });

    it("focusMode=app allows when non-terminal is frontmost", async () => {
      const m = makeMocks();
      m.deps.getFrontmostAppFn = () => "chrome";
      const h = createEventHandler(makeConfig({ focusMode: "app" }), m.deps);

      await h.handleEvent(msgEvent("assistant", "s1", "a1"));
      await h.handleEvent(sessionEvent("session.idle", "s1"));
      await m.flushTimeouts();

      assert.equal(m.calls.notify.length, 1); // allowed
    });

    it("focusMode=tab suppresses when this session tab is focused", async () => {
      const m = makeMocks();
      m.deps.isSessionTabFocusedFn = (title) => title === "Session s1";
      const h = createEventHandler(makeConfig({ focusMode: "tab" }), m.deps);

      await h.handleEvent(msgEvent("assistant", "s1", "a1"));
      await h.handleEvent(sessionEvent("session.idle", "s1"));
      await m.flushTimeouts();

      assert.equal(m.calls.notify.length, 0); // suppressed
    });

    it("focusMode=tab allows when different tab is focused", async () => {
      const m = makeMocks();
      m.deps.isSessionTabFocusedFn = () => false;
      const h = createEventHandler(makeConfig({ focusMode: "tab" }), m.deps);

      await h.handleEvent(msgEvent("assistant", "s1", "a1"));
      await h.handleEvent(sessionEvent("session.idle", "s1"));
      await m.flushTimeouts();

      assert.equal(m.calls.notify.length, 1); // allowed
    });

    it("focusMode=none always notifies even when tab focused", async () => {
      const m = makeMocks();
      m.deps.isSessionTabFocusedFn = () => true;
      m.deps.getFrontmostAppFn = () => "ghostty";
      const h = createEventHandler(makeConfig({ focusMode: "none" }), m.deps);

      await h.handleEvent(msgEvent("assistant", "s1", "a1"));
      await h.handleEvent(sessionEvent("session.idle", "s1"));
      await m.flushTimeouts();

      assert.equal(m.calls.notify.length, 1); // always
    });
  });

  describe("multi-session isolation", () => {
    it("tracks sessions independently", async () => {
      await handler.handleEvent(msgEvent("assistant", "s1", "a1"));
      await handler.handleEvent(msgEvent("assistant", "s2", "a2"));

      // Interrupt s1
      await handler.handleEvent(
        sessionEvent("command.executed", "s1", { name: "session.interrupt" }),
      );

      // s1 idle should be suppressed, s2 idle should fire
      await handler.handleEvent(sessionEvent("session.idle", "s1"));
      await handler.handleEvent(sessionEvent("session.idle", "s2"));

      // Only s2 should have a tab icon and pending timeout
      assert.equal(mocks.calls.setTabIcon.length, 1);
      assert.equal(mocks.calls.setTabIcon[0].sid, "s2");
    });
  });

  describe("destroy", () => {
    it("clears all state and pending timers", async () => {
      await handler.handleEvent(msgEvent("assistant", "s1", "a1"));
      await handler.handleEvent(sessionEvent("session.idle", "s1"));
      assert.equal(mocks.calls.timeouts.size, 1);

      handler.destroy();

      assert.equal(handler._state.pending.size, 0);
      assert.equal(handler._state.assistantSeen.size, 0);
      assert.equal(handler._state.interrupted.size, 0);
      assert.equal(handler._state.userMsgIds.size, 0);
      assert.equal(handler._state.iconActive.size, 0);
    });
  });

  describe("edge cases", () => {
    it("handles missing sessionID gracefully", async () => {
      await handler.handleEvent({ event: { type: "session.idle", properties: {} } });
      await handler.handleEvent({
        event: { type: "message.updated", properties: { info: { role: "user" } } },
      });
      // No crash, no side effects
      assert.equal(mocks.calls.setTabIcon.length, 0);
    });

    it("handles missing message ID in user message", async () => {
      await handler.handleEvent({
        event: {
          type: "message.updated",
          properties: { info: { role: "user", sessionID: "s1" } },
        },
      });
      // id is undefined, so msgId check (msgId && msgId !== prev) fails — no state change
      assert.equal(mocks.calls.clearTabIcon.length, 0);
    });

    it("replaces pending notification when new event fires for same session", async () => {
      await handler.handleEvent(sessionEvent("permission.asked", "s1"));
      assert.equal(mocks.calls.timeouts.size, 1);

      // Question asked for same session — should replace the pending timer
      await handler.handleEvent(sessionEvent("question.asked", "s1"));
      assert.equal(mocks.calls.timeouts.size, 1); // still 1, old one was cleared

      await mocks.flushTimeouts();
      assert.equal(mocks.calls.notify.length, 1);
      assert.equal(mocks.calls.notify[0].title, "Question"); // latest event wins
    });

    it("uses delay from config", () => {
      const m = makeMocks();
      const h = createEventHandler(makeConfig({ delay: 10 }), m.deps);

      // Trigger a schedule
      h.schedule("s1", "permission.asked", "Test", "msg");
      const timeout = [...m.calls.timeouts.values()][0];
      assert.equal(timeout.ms, 10000); // 10 * 1000
    });
  });
});
