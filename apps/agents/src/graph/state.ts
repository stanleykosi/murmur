/**
 * Shared graph-state contracts for the Murmur agent conversation loop.
 *
 * This module defines the canonical LangGraph state, node names, and injected
 * runtime bindings. The graph is intentionally runner-agnostic: callers provide
 * the current room/session bridges and side effects instead of the graph owning
 * process lifecycle.
 */

import { Annotation } from "@langchain/langgraph";
import type {
  TranscriptEntry,
  TranscriptEvent,
} from "@murmur/shared";

import type { ContextManager } from "../context/manager.js";
import type { LLMProvider } from "../llm/provider.js";
import type { AgentRuntimeProfile } from "../runtime/agent-profile.js";
import type { TTSProvider } from "../tts/provider.js";

/**
 * Supported statuses for the Murmur agent graph.
 */
export type AgentGraphStatus = "idle" | "listening" | "thinking" | "speaking";

/**
 * Canonical node names for the Murmur agent graph.
 */
export const AGENT_GRAPH_NODE_NAMES = {
  listen: "listen",
  think: "think",
  moderate: "moderate",
  speak: "speak",
} as const;

/**
 * Union of all node names in the Murmur agent graph.
 */
export type AgentGraphNodeName =
  (typeof AGENT_GRAPH_NODE_NAMES)[keyof typeof AGENT_GRAPH_NODE_NAMES];

/**
 * Runtime floor status returned by the caller-owned floor controller.
 */
export interface AgentFloorStatus {
  isFloorHolder: boolean;
}

/**
 * Cleanup payload emitted after a graph speaking turn finishes or fails.
 */
export interface FinalizeTurnInput {
  roomId: string;
  agentId: string;
  spokeAt: number | null;
}

/**
 * Payload emitted when a moderated turn is ready to enter speech playback.
 */
export interface TurnReadyForPlaybackInput {
  roomId: string;
  agentId: string;
  content: string;
  timestamp: string;
  wasFiltered: boolean;
}

/**
 * Minimal logger surface required by the graph nodes.
 */
export interface AgentGraphLogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/**
 * Output adapter used by the graph's `speak` node.
 */
export interface AgentSessionBridge {
  /**
   * Publishes synthesized PCM audio through a started LiveKit session.
   *
   * @param text - Spoken text associated with the PCM payload.
   * @param pcmAudio - Raw 24 kHz PCM audio bytes to publish.
   */
  speakText(text: string, pcmAudio: Buffer): Promise<void>;
}

/**
 * Side-effect bindings required by the Murmur graph nodes.
 */
export interface AgentGraphBindings {
  agent: AgentRuntimeProfile;
  roomId: string;
  llmProvider: LLMProvider;
  ttsProvider: TTSProvider;
  contextManager: ContextManager;
  sessionBridge: AgentSessionBridge;
  getFloorStatus(): Promise<AgentFloorStatus>;
  getTranscriptSnapshot(): Promise<TranscriptEntry[]>;
  publishTranscript(event: TranscriptEvent): Promise<void>;
  finalizeTurn(input: FinalizeTurnInput): Promise<void>;
  onTurnReadyForPlayback?(input: TurnReadyForPlaybackInput): Promise<void>;
  logger: AgentGraphLogger;
  now(): Date;
}

/**
 * Canonical graph state shape for one Murmur agent turn cycle.
 */
export interface AgentGraphStateShape {
  agentId: string;
  roomId: string;
  status: AgentGraphStatus;
  rollingTranscript: TranscriptEntry[];
  currentResponse: string | null;
  currentResponseWasFiltered: boolean;
  lastSpokeAt: number;
  turnCount: number;
  isFloorHolder: boolean;
}

/**
 * Validates a required string field and returns the trimmed value.
 *
 * @param value - Raw string-like value supplied by a caller.
 * @param label - Human-readable field name used in diagnostics.
 * @returns The trimmed string value.
 * @throws {Error} When the value is not a string or is blank.
 */
export function normalizeRequiredText(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }

  const normalizedValue = value.trim();

  if (normalizedValue.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return normalizedValue;
}

/**
 * Validates that a `Date` instance is usable for graph timestamping.
 *
 * @param value - Candidate date value.
 * @returns The validated `Date` instance.
 * @throws {Error} When the supplied value is not a valid `Date`.
 */
export function normalizeNow(value: Date): Date {
  if (!(value instanceof Date)) {
    throw new Error("now() must return a Date instance.");
  }

  if (!Number.isFinite(value.getTime())) {
    throw new Error("now() must return a valid Date.");
  }

  return value;
}

/**
 * Creates an annotation that always replaces the stored value on update.
 *
 * @param defaultValue - Factory for the field's initial value.
 * @returns A LangGraph annotation with replacement semantics.
 */
function replaceValueAnnotation<ValueType>(defaultValue: () => ValueType) {
  return Annotation<ValueType>({
    reducer: (_left, right) => right,
    default: defaultValue,
  });
}

/**
 * Canonical LangGraph annotation for the Murmur agent state.
 */
export const AgentGraphAnnotation = Annotation.Root({
  agentId: replaceValueAnnotation<string>(() => ""),
  roomId: replaceValueAnnotation<string>(() => ""),
  status: replaceValueAnnotation<AgentGraphStatus>(() => "idle"),
  rollingTranscript: replaceValueAnnotation<TranscriptEntry[]>(() => []),
  currentResponse: replaceValueAnnotation<string | null>(() => null),
  currentResponseWasFiltered: replaceValueAnnotation<boolean>(() => false),
  lastSpokeAt: replaceValueAnnotation<number>(() => 0),
  turnCount: replaceValueAnnotation<number>(() => 0),
  isFloorHolder: replaceValueAnnotation<boolean>(() => false),
});

/**
 * Concrete state type inferred from the LangGraph annotation.
 */
export type AgentGraphState = typeof AgentGraphAnnotation.State;

/**
 * Creates the canonical initial state for one graph invocation.
 *
 * @param params - Required identifiers for the current agent and room.
 * @returns A fully populated state object with Murmur's default field values.
 */
export function createInitialAgentGraphState(params: {
  agentId: string;
  roomId: string;
}): AgentGraphState {
  return {
    agentId: normalizeRequiredText(params.agentId, "agentId"),
    roomId: normalizeRequiredText(params.roomId, "roomId"),
    status: "idle",
    rollingTranscript: [],
    currentResponse: null,
    currentResponseWasFiltered: false,
    lastSpokeAt: 0,
    turnCount: 0,
    isFloorHolder: false,
  };
}
