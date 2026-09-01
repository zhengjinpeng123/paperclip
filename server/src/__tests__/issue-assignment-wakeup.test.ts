import { describe, expect, it, vi } from "vitest";
import {
  queueIssueAssignmentWakeup,
  shouldAutoWakeOnIssueAssignment,
} from "../services/issue-assignment-wakeup.ts";

const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";

describe("issue assignment execution gate", () => {
  it("defaults assignment wakeups to off", () => {
    expect(shouldAutoWakeOnIssueAssignment({})).toBe(false);
    expect(shouldAutoWakeOnIssueAssignment({ executionPolicy: null })).toBe(false);
    expect(shouldAutoWakeOnIssueAssignment({ executionPolicy: { autoWakeOnAssignment: false } })).toBe(false);
  });

  it("allows assignment wakeups only when explicitly enabled", () => {
    expect(shouldAutoWakeOnIssueAssignment({ executionPolicy: { autoWakeOnAssignment: true } })).toBe(true);
  });

  it("does not wake an assigned todo task under the default policy", () => {
    const wakeup = vi.fn();
    const result = queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: { id: ISSUE_ID, assigneeAgentId: AGENT_ID, status: "todo", executionPolicy: null },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
    });

    expect(result).toBeUndefined();
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("wakes an assigned todo task when automatic assignment execution is enabled", async () => {
    const wakeup = vi.fn().mockResolvedValue({ id: "run-1" });
    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: {
        id: ISSUE_ID,
        assigneeAgentId: AGENT_ID,
        status: "todo",
        executionPolicy: { autoWakeOnAssignment: true },
      },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
      requestedByActorType: "user",
      requestedByActorId: "board-user",
    });

    expect(wakeup).toHaveBeenCalledWith(AGENT_ID, expect.objectContaining({
      source: "assignment",
      reason: "issue_assigned",
      payload: expect.objectContaining({ issueId: ISSUE_ID, mutation: "create" }),
    }));
  });

  it("allows an explicit automation trigger without changing assignment policy", async () => {
    const wakeup = vi.fn().mockResolvedValue({ id: "run-routine" });
    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: { id: ISSUE_ID, assigneeAgentId: AGENT_ID, status: "todo", executionPolicy: null },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "routine.dispatch",
      explicitExecutionTrigger: true,
    });

    expect(wakeup).toHaveBeenCalledTimes(1);
  });
});
