/**
 * Unit tests for the Murmur agent LangGraph loop.
 *
 * These assertions pin graph behavior so runner and floor controller work can
 * integrate against a stable conversation-loop contract.
 */

import type { TranscriptEntry, TranscriptEvent } from "@murmur/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextManager } from "../context/manager.js";
import type { LLMProvider } from "../llm/provider.js";
import type { AgentRuntimeProfile } from "../runtime/agent-profile.js";
import type { TTSProvider } from "../tts/provider.js";
import { createAgentGraph } from "./agent-graph.js";
import {
  createInitialAgentGraphState,
  type AgentGraphBindings,
  type AgentGraphLogger,
  type FinalizeTurnInput,
} from "./state.js";

/**
 * Creates a quiet logger double for graph tests.
 *
 * @returns Logger methods backed by Vitest spies.
 */
function createLogger(): AgentGraphLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/**
 * Canonical runtime-facing agent fixture for graph tests.
 */
const TEST_AGENT: AgentRuntimeProfile = {
  id: "agent-nova",
  name: "Nova",
  personality: "Curious, incisive, and energetic.",
  voiceId: "voice-nova",
  ttsProvider: "cartesia",
  accentColor: "#00D4FF",
  avatarUrl: "/agents/nova.png",
  role: "host",
};

/**
 * Creates a transcript entry fixture with Murmur's shared field contract.
 *
 * @param overrides - Per-test overrides for the default transcript shape.
 * @returns A complete transcript entry fixture.
 */
function createTranscriptEntry(
  overrides: Partial<TranscriptEntry> = {},
): TranscriptEntry {
  return {
    id: overrides.id ?? "entry-1",
    roomId: overrides.roomId ?? "room-1",
    agentId: overrides.agentId ?? "agent-a",
    agentName: overrides.agentName ?? "Nova",
    content: overrides.content ?? "Default content",
    timestamp: overrides.timestamp ?? "2026-03-28T12:00:00.000Z",
    accentColor: overrides.accentColor ?? "#00D4FF",
    wasFiltered: overrides.wasFiltered ?? false,
  };
}

/**
 * Creates one graph-binding bundle with injectable test doubles.
 *
 * @param options - Test-specific overrides for graph collaborators.
 * @returns The bindings plus helper spies used in assertions.
 */
function createBindings(
  options: {
    floorStatus?: { isFloorHolder: boolean };
    transcriptSnapshot?: TranscriptEntry[];
    llmResponse?: string;
    ttsBuffer?: Buffer;
    llmImplementation?: LLMProvider["generateResponse"];
    ttsImplementation?: TTSProvider["synthesize"];
    sessionImplementation?: (
      text: string,
      pcmAudio: Buffer,
    ) => Promise<void>;
    publishImplementation?: (event: TranscriptEvent) => Promise<void>;
    finalizeImplementation?: (input: FinalizeTurnInput) => Promise<void>;
    now?: Date;
  } = {},
) {
  const logger = createLogger();
  const contextManager = new ContextManager({
    now: () => Date.parse("2026-03-28T12:00:30.000Z"),
  });
  const floorState = {
    isFloorHolder: options.floorStatus?.isFloorHolder ?? false,
  };
  const transcriptSnapshot = [
    ...(options.transcriptSnapshot ?? []),
  ];
  const llmProvider: LLMProvider = {
    generateResponse:
      options.llmImplementation
      ?? vi.fn(async () => options.llmResponse ?? "Fresh response from the model."),
  };
  const ttsProvider: TTSProvider = {
    synthesize:
      options.ttsImplementation
      ?? vi.fn(async () => options.ttsBuffer ?? Buffer.from([0, 1, 2, 3])),
  };
  const sessionBridge = {
    speakText:
      vi.fn(options.sessionImplementation ?? (async () => Promise.resolve())),
  };
  const publishedEvents: TranscriptEvent[] = [];
  const finalizedTurns: FinalizeTurnInput[] = [];
  const publishTranscript = vi.fn(
    options.publishImplementation
    ?? (async (event: TranscriptEvent) => {
      publishedEvents.push(event);
      const { type: _type, ...transcriptEntry } = event;

      transcriptSnapshot.push(transcriptEntry);
    }),
  );
  const finalizeTurn = vi.fn(
    options.finalizeImplementation
    ?? (async (input: FinalizeTurnInput) => {
      finalizedTurns.push(input);
      floorState.isFloorHolder = false;
    }),
  );
  const getFloorStatus = vi.fn(async () => ({
    isFloorHolder: floorState.isFloorHolder,
  }));
  const getTranscriptSnapshot = vi.fn(async () => [...transcriptSnapshot]);
  const bindings: AgentGraphBindings = {
    agent: TEST_AGENT,
    roomId: "room-1",
    llmProvider,
    ttsProvider,
    contextManager,
    sessionBridge,
    getFloorStatus,
    getTranscriptSnapshot,
    publishTranscript,
    finalizeTurn,
    logger,
    now: () => new Date(options.now ?? "2026-03-28T12:34:56.000Z"),
  };

  return {
    bindings,
    finalizedTurns,
    getFloorStatus,
    getTranscriptSnapshot,
    llmProvider,
    logger,
    publishedEvents,
    publishTranscript,
    sessionBridge,
    ttsProvider,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createAgentGraph", () => {
  /**
   * When the floor is not held, the graph should synchronize transcript state
   * once and then end without invoking any generation or speech work.
   */
  it("ends immediately after listen when the floor is not held", async () => {
    const { bindings, llmProvider, publishTranscript, sessionBridge, ttsProvider } =
      createBindings({
        floorStatus: { isFloorHolder: false },
        transcriptSnapshot: [createTranscriptEntry()],
      });
    const graph = createAgentGraph(bindings);

    const result = await graph.invoke(
      createInitialAgentGraphState({
        agentId: "agent-nova",
        roomId: "room-1",
      }),
    );

    expect(result.status).toBe("listening");
    expect(result.isFloorHolder).toBe(false);
    expect(result.rollingTranscript).toHaveLength(1);
    expect(llmProvider.generateResponse).not.toHaveBeenCalled();
    expect(ttsProvider.synthesize).not.toHaveBeenCalled();
    expect(sessionBridge.speakText).not.toHaveBeenCalled();
    expect(publishTranscript).not.toHaveBeenCalled();
  });

  /**
   * With the floor granted, the graph should think, moderate, speak, and then
   * end with the next-turn listening state already populated.
   */
  it("runs think, moderate, and speak before ending", async () => {
    const { bindings, finalizedTurns, getFloorStatus, getTranscriptSnapshot, llmProvider, publishTranscript, sessionBridge, ttsProvider } =
      createBindings({
        floorStatus: { isFloorHolder: true },
        transcriptSnapshot: [
          createTranscriptEntry({
            id: "entry-1",
            content: "We should define AGI carefully.",
          }),
        ],
        llmResponse: "That's fair, but timelines still matter.",
      });
    const graph = createAgentGraph(bindings);

    const result = await graph.invoke(
      createInitialAgentGraphState({
        agentId: "agent-nova",
        roomId: "room-1",
      }),
    );

    expect(result.status).toBe("listening");
    expect(result.turnCount).toBe(1);
    expect(result.currentResponse).toBeNull();
    expect(result.isFloorHolder).toBe(false);
    expect(llmProvider.generateResponse).toHaveBeenCalledTimes(1);
    expect(ttsProvider.synthesize).toHaveBeenCalledTimes(1);
    expect(sessionBridge.speakText).toHaveBeenCalledTimes(1);
    expect(publishTranscript).toHaveBeenCalledTimes(1);
    expect(finalizedTurns).toEqual([
      expect.objectContaining({
        agentId: "agent-nova",
        roomId: "room-1",
        spokeAt: Date.parse("2026-03-28T12:34:56.000Z"),
      }),
    ]);
    expect(getFloorStatus).toHaveBeenCalledTimes(1);
    expect(getTranscriptSnapshot).toHaveBeenCalledTimes(1);
  });

  /**
   * Transcript snapshots should be de-duplicated by ID, sorted
   * chronologically, and rebuilt into the rolling context before generation.
   */
  it("deduplicates and sorts transcript snapshots before building prompt context", async () => {
    const transcriptSnapshot = [
      createTranscriptEntry({
        id: "same-entry",
        content: "This duplicate should collapse.",
        timestamp: "2026-03-28T12:00:02.000Z",
      }),
      createTranscriptEntry({
        id: "entry-b",
        agentName: "Rex",
        content: "Second in time.",
        timestamp: "2026-03-28T12:00:01.000Z",
      }),
      createTranscriptEntry({
        id: "same-entry",
        content: "This duplicate should collapse.",
        timestamp: "2026-03-28T12:00:02.000Z",
      }),
      createTranscriptEntry({
        id: "entry-a",
        agentName: "Nova",
        content: "First in time.",
        timestamp: "2026-03-28T12:00:00.000Z",
      }),
    ];
    const llmSpy = vi.fn(async () => "Clean response.");
    const { bindings } = createBindings({
      floorStatus: { isFloorHolder: true },
      transcriptSnapshot,
      llmImplementation: llmSpy,
    });
    const graph = createAgentGraph(bindings);

    const result = await graph.invoke(
      createInitialAgentGraphState({
        agentId: "agent-nova",
        roomId: "room-1",
      }),
    );

    expect(result.rollingTranscript.map((entry) => entry.id)).toEqual([
      "entry-a",
      "entry-b",
      "same-entry",
      expect.any(String),
    ]);
    expect(llmSpy).toHaveBeenCalledWith(
      bindings.agent.personality,
      "[Nova]: First in time.\n[Rex]: Second in time.\n[Nova]: This duplicate should collapse.",
    );
  });

  /**
   * The think node should pass the current personality prompt and formatted
   * rolling context to the injected LLM provider and store the trimmed output.
   */
  it("passes personality and context into the LLM provider", async () => {
    const llmSpy = vi.fn(async () => "  We need sharper definitions first.  ");
    const { bindings, ttsProvider } = createBindings({
      floorStatus: { isFloorHolder: true },
      transcriptSnapshot: [
        createTranscriptEntry({
          agentName: "Sage",
          content: "Let's define the terms.",
        }),
      ],
      llmImplementation: llmSpy,
    });
    const graph = createAgentGraph(bindings);

    const result = await graph.invoke(
      createInitialAgentGraphState({
        agentId: "agent-nova",
        roomId: "room-1",
      }),
    );

    expect(llmSpy).toHaveBeenCalledWith(
      bindings.agent.personality,
      "[Sage]: Let's define the terms.",
    );
    expect(ttsProvider.synthesize).toHaveBeenCalledWith(
      "We need sharper definitions first.",
      bindings.agent.voiceId,
    );
    expect(result.turnCount).toBe(1);
  });

  /**
   * Moderation should replace blocked terms, carry the filtered flag into the
   * transcript event, and speak the cleaned text instead of the original text.
   */
  it("filters blocked content before synthesis and publication", async () => {
    const { bindings, publishedEvents, sessionBridge, ttsProvider } =
      createBindings({
        floorStatus: { isFloorHolder: true },
        llmResponse: "fuck this timeline optimism",
      });
    const graph = createAgentGraph(bindings);

    const result = await graph.invoke(
      createInitialAgentGraphState({
        agentId: "agent-nova",
        roomId: "room-1",
      }),
    );

    expect(ttsProvider.synthesize).toHaveBeenCalledWith(
      "[filtered] this timeline optimism",
      bindings.agent.voiceId,
    );
    expect(sessionBridge.speakText).toHaveBeenCalledWith(
      "[filtered] this timeline optimism",
      expect.any(Buffer),
    );
    expect(publishedEvents).toEqual([
      expect.objectContaining({
        content: "[filtered] this timeline optimism",
        wasFiltered: true,
      }),
    ]);
    expect(result.turnCount).toBe(1);
    expect(result.currentResponse).toBeNull();
  });

  /**
   * Finalization must still run when speech playout fails, and the original
   * playout error should be the one surfaced to callers.
   */
  it("finalizes the turn with spokeAt null when playout fails", async () => {
    const playoutError = new Error("LiveKit playout failed.");
    const { bindings, finalizedTurns, publishTranscript, sessionBridge } =
      createBindings({
        floorStatus: { isFloorHolder: true },
        llmResponse: "A clean response.",
        sessionImplementation: async () => {
          throw playoutError;
        },
      });
    const graph = createAgentGraph(bindings);

    await expect(
      graph.invoke(
        createInitialAgentGraphState({
          agentId: "agent-nova",
          roomId: "room-1",
        }),
      ),
    ).rejects.toBe(playoutError);

    expect(sessionBridge.speakText).toHaveBeenCalledTimes(1);
    expect(publishTranscript).not.toHaveBeenCalled();
    expect(finalizedTurns).toEqual([
      {
        agentId: "agent-nova",
        roomId: "room-1",
        spokeAt: null,
      },
    ]);
  });

  /**
   * The graph should still stop after one response even when floor release is
   * handled asynchronously outside the immediate invocation.
   */
  it("ends after one completed speech turn even if the floor still appears held", async () => {
    const { bindings, getFloorStatus, getTranscriptSnapshot, llmProvider, publishTranscript, sessionBridge, ttsProvider } =
      createBindings({
        floorStatus: { isFloorHolder: true },
        finalizeImplementation: async () => Promise.resolve(),
      });
    const graph = createAgentGraph(bindings);

    const result = await graph.invoke(
      createInitialAgentGraphState({
        agentId: "agent-nova",
        roomId: "room-1",
      }),
    );

    expect(result.status).toBe("listening");
    expect(result.turnCount).toBe(1);
    expect(result.isFloorHolder).toBe(false);
    expect(llmProvider.generateResponse).toHaveBeenCalledTimes(1);
    expect(ttsProvider.synthesize).toHaveBeenCalledTimes(1);
    expect(sessionBridge.speakText).toHaveBeenCalledTimes(1);
    expect(publishTranscript).toHaveBeenCalledTimes(1);
    expect(getFloorStatus).toHaveBeenCalledTimes(1);
    expect(getTranscriptSnapshot).toHaveBeenCalledTimes(1);
  });
});
