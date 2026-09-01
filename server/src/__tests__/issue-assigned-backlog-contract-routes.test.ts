import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const assigneeAgentId = "22222222-2222-4222-8222-222222222222";

const mockWakeup = vi.hoisted(() => vi.fn(async () => undefined));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockDbSelectRows = vi.hoisted(() => vi.fn(async () => []));
const mockIssueService = vi.hoisted(() => ({
  create: vi.fn(),
  createChild: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getComment: vi.fn(),
  getCommentCursor: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  getDependencyReadiness: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(async () => true),
    decide: vi.fn(async (input: { action?: string }) => ({
      allowed: true,
      action: input.action,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant.",
    })),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: vi.fn(async () => null),
    resolveByReference: vi.fn(async (_companyId: string, reference: string) => ({
      ambiguous: false,
      agent: {
        id: reference,
        companyId: "company-1",
        status: "active",
        orgChainHealth: { status: "healthy" },
      },
    })),
  }),
  companySkillService: () => ({
    completeTestRunForIssue: vi.fn(async () => null),
  }),
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(async () => null),
  }),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
  }),
  goalService: () => ({
    getById: vi.fn(async () => null),
    getDefaultCompanyGoal: vi.fn(async () => null),
  }),
  heartbeatService: () => ({
    wakeup: mockWakeup,
    reportRunActivity: vi.fn(async () => undefined),
  }),
  getIssueContinuationSummaryDocument: vi.fn(async () => null),
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    })),
    listCompanyIds: vi.fn(async () => ["company-1"]),
  }),
  issueApprovalService: () => ({}),
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueThreadInteractionService: () => ({
    listForIssue: vi.fn(async () => []),
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  }),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({
    getById: vi.fn(async () => null),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

async function createApp() {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => mockDbSelectRows(),
        }),
      }),
    }),
  };
  app.use("/api", issueRoutes(db as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(input: {
  id: string;
  title: string;
  status?: string;
  parentId?: string | null;
  assigneeAgentId?: string | null;
  executionPolicy?: Record<string, unknown> | null;
}) {
  return {
    id: input.id,
    companyId: "company-1",
    identifier: input.id === "child-1" ? "PAP-3701" : "PAP-3700",
    title: input.title,
    description: null,
    status: input.status ?? "todo",
    priority: "medium",
    parentId: input.parentId ?? null,
    assigneeAgentId: input.assigneeAgentId ?? null,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: "local-board",
    executionWorkspaceId: null,
    executionPolicy: input.executionPolicy ?? null,
    labels: [],
    labelIds: [],
  };
}

function expectClearAssignedStatusValidation(res: request.Response) {
  expect([400, 422]).toContain(res.status);
  expect(String(res.body?.error ?? res.text)).toMatch(/assign|assignee|status|backlog|todo/i);
}

describe("assigned backlog creation contract", () => {
  // Load the real route and middleware modules once before the tests run. The
  // first import transforms a large module graph. Under the loaded serial shard
  // (maxWorkers=1) that cold cost crossed the 5s testTimeout of the first test.
  // The hook has a 30s budget, so it absorbs the cost and every createApp() call
  // then hits the cached modules.
  beforeAll(async () => {
    await createApp();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(makeIssue({
      id: "parent-1",
      title: "Parent issue",
      status: "blocked",
      assigneeAgentId,
    }));
    mockIssueService.create.mockImplementation(async (_companyId: string, data: Record<string, unknown>) =>
      makeIssue({
        id: String(data.id),
        title: String(data.title),
        status: String(data.status),
        assigneeAgentId: data.assigneeAgentId as string | null | undefined,
        executionPolicy: data.executionPolicy as Record<string, unknown> | null | undefined,
      }));
    mockIssueService.createChild.mockImplementation(async (_parentId: string, data: Record<string, unknown>) => ({
      issue: makeIssue({
        id: "child-1",
        title: String(data.title),
        status: String(data.status),
        parentId: "parent-1",
        assigneeAgentId: data.assigneeAgentId as string | null | undefined,
        executionPolicy: data.executionPolicy as Record<string, unknown> | null | undefined,
      }),
      parentBlockerAdded: Boolean(data.blockParentUntilDone),
    }));
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      unresolvedBlockerCount: 0,
      blockerIssueIds: [],
    });
    mockDbSelectRows.mockResolvedValue([]);
  });

  it("does not silently create a top-level assigned issue as backlog when status is omitted", async () => {
    const res = await request(await createApp())
      .post("/api/companies/company-1/issues")
      .send({
        title: "Assigned executable work",
        assigneeAgentId,
      });

    if (res.status !== 201) {
      expectClearAssignedStatusValidation(res);
      expect(mockIssueService.create).not.toHaveBeenCalled();
      expect(mockWakeup).not.toHaveBeenCalled();
      return;
    }

    expect(mockIssueService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title: "Assigned executable work",
        assigneeAgentId,
        status: "todo",
      }),
    );
    expect(res.body).toEqual(expect.objectContaining({
      assigneeAgentId,
      status: "todo",
    }));
    expect(mockWakeup).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.created",
        details: expect.objectContaining({
          status: "todo",
          statusDefaulted: true,
          statusDefaultReason: "assigned_omitted_status",
          assignmentWakeSkipped: true,
          assignmentWakeSkipReason: "assignment_execution_gate",
        }),
      }),
    );
  });

  it("creates a parent-blocking assigned child ready but waiting for explicit execution", async () => {
    const res = await request(await createApp())
      .post("/api/issues/parent-1/children")
      .send({
        title: "Assigned child blocker",
        assigneeAgentId,
        blockParentUntilDone: true,
      });

    if (res.status !== 201) {
      expectClearAssignedStatusValidation(res);
      expect(mockIssueService.createChild).not.toHaveBeenCalled();
      expect(mockWakeup).not.toHaveBeenCalled();
      return;
    }

    expect(mockIssueService.createChild).toHaveBeenCalledWith(
      "parent-1",
      expect.objectContaining({
        title: "Assigned child blocker",
        assigneeAgentId,
        blockParentUntilDone: true,
        status: "todo",
      }),
    );
    expect(res.body).toEqual(expect.objectContaining({
      assigneeAgentId,
      parentId: "parent-1",
      status: "todo",
    }));
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.child_created",
        details: expect.objectContaining({
          status: "todo",
          statusDefaulted: true,
          statusDefaultReason: "assigned_omitted_status",
          assignmentWakeSkipped: true,
          assignmentWakeSkipReason: "assignment_execution_gate",
          parentBlockerAdded: true,
        }),
      }),
    );
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it("preserves automatic assignment execution when explicitly enabled", async () => {
    const res = await request(await createApp())
      .post("/api/companies/company-1/issues")
      .send({
        title: "Explicitly automatic work",
        assigneeAgentId,
        executionPolicy: { autoWakeOnAssignment: true, stages: [] },
      });

    expect(res.status).toBe(201);
    expect(mockWakeup).toHaveBeenCalledWith(
      assigneeAgentId,
      expect.objectContaining({
        source: "assignment",
        reason: "issue_assigned",
        payload: expect.objectContaining({ mutation: "create" }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.created",
        details: expect.objectContaining({
          assignmentWakeSkipped: false,
          assignmentWakeSkipReason: null,
        }),
      }),
    );
  });

  it("preserves deliberate assigned backlog as parked work without assignment wakeup", async () => {
    const res = await request(await createApp())
      .post("/api/companies/company-1/issues")
      .send({
        title: "Parked assigned work",
        assigneeAgentId,
        status: "backlog",
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title: "Parked assigned work",
        assigneeAgentId,
        status: "backlog",
      }),
    );
    expect(res.body).toEqual(expect.objectContaining({
      assigneeAgentId,
      status: "backlog",
    }));
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.created",
        entityId: expect.any(String),
        details: expect.objectContaining({
          status: "backlog",
          statusDefaulted: false,
          statusDefaultReason: "explicit",
          assignmentWakeSkipped: true,
          assignmentWakeSkipReason: "assigned_backlog",
        }),
      }),
    );
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it("starts a task only after the board explicitly executes it", async () => {
    const issue = makeIssue({
      id: "execute-1",
      title: "Ready for explicit execution",
      assigneeAgentId,
      status: "todo",
    });
    mockIssueService.getById.mockResolvedValue(issue);
    mockWakeup.mockResolvedValueOnce({ id: "run-explicit-1" });

    const res = await request(await createApp())
      .post(`/api/issues/${issue.id}/execute`)
      .send({});

    expect(res.status).toBe(202);
    expect(mockWakeup).toHaveBeenCalledWith(
      assigneeAgentId,
      expect.objectContaining({
        source: "on_demand",
        triggerDetail: "manual",
        reason: "issue_execution_requested",
        payload: expect.objectContaining({ issueId: issue.id, mutation: "execute" }),
        contextSnapshot: expect.objectContaining({
          issueId: issue.id,
          taskId: issue.id,
          source: "issue.execute",
        }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.execution_requested",
        entityId: issue.id,
        runId: "run-explicit-1",
      }),
    );
  });

  it("rejects explicit execution when the task has no agent assignee", async () => {
    const issue = makeIssue({
      id: "execute-unassigned",
      title: "Missing assignee",
      status: "todo",
    });
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp())
      .post(`/api/issues/${issue.id}/execute`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("issue_execution_assignee_required");
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it("rejects explicit execution when any live run already owns the task", async () => {
    const issue = makeIssue({
      id: "execute-live",
      title: "Already running under a previous assignee",
      assigneeAgentId,
      status: "todo",
    });
    mockIssueService.getById.mockResolvedValue(issue);
    mockDbSelectRows.mockResolvedValueOnce([{ id: "run-existing" }]);

    const res = await request(await createApp())
      .post(`/api/issues/${issue.id}/execute`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({
      code: "issue_execution_already_live",
      runId: "run-existing",
    }));
    expect(mockWakeup).not.toHaveBeenCalled();
  });
});
