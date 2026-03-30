/**
 * LangGraph speak node for the Murmur agent loop.
 *
 * The speak node synthesizes the moderated response, publishes it through the
 * injected LiveKit session bridge, emits a transcript event, and always runs
 * caller-owned turn finalization so future floor-control work cannot deadlock
 * the room on failure.
 */

import type { TranscriptEvent } from "@murmur/shared";

import type { AgentGraphBindings, AgentGraphState } from "../state.js";
import { normalizeNow, normalizeRequiredText } from "../state.js";

/**
 * Normalizes a numeric turn count before incrementing it.
 *
 * @param value - Current turn count from graph state.
 * @returns The validated count.
 * @throws {Error} When the count is not a non-negative integer.
 */
function normalizeTurnCount(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("state.turnCount must be a non-negative integer.");
  }

  return value;
}

/**
 * Executes the canonical speech/publication/finalization flow for one ready
 * response. Callers may supply a pre-synthesized buffer to reuse speculative
 * preparation work instead of synthesizing again inside the turn.
 *
 * @param bindings - Caller-owned graph bindings for the current runner.
 * @param state - Current graph state for the active turn.
 * @param responseText - Final moderated turn text to publish.
 * @param responseWasFiltered - Whether moderation changed the response.
 * @param synthesizedAudio - Optional pre-synthesized PCM audio for the turn.
 * @returns The next graph state after the turn completes.
 */
export async function executeSpeakTurn(
  bindings: AgentGraphBindings,
  state: AgentGraphState,
  responseText: string,
  responseWasFiltered: boolean,
  synthesizedAudio?: Buffer,
): Promise<Partial<AgentGraphState>> {
  const roomId = normalizeRequiredText(state.roomId, "state.roomId");
  const agentId = normalizeRequiredText(state.agentId, "state.agentId");
  const normalizedResponse = normalizeRequiredText(
    responseText,
    "responseText",
  );
  const turnCount = normalizeTurnCount(state.turnCount);
  let spokeAt: number | null = null;
  let pendingError: unknown;
  let nextState: Partial<AgentGraphState> | undefined;

  try {
    const queuedAt = normalizeNow(bindings.now());

    await bindings.onTurnReadyForPlayback?.({
      roomId,
      agentId,
      content: normalizedResponse,
      timestamp: queuedAt.toISOString(),
      wasFiltered: responseWasFiltered,
    });

    const audioBuffer = synthesizedAudio
      ?? await bindings.ttsProvider.synthesize(
        normalizedResponse,
        bindings.agent.voiceId,
      );

    await bindings.sessionBridge.speakText(normalizedResponse, audioBuffer);

    const spokenAt = normalizeNow(bindings.now());
    spokeAt = spokenAt.getTime();

    const transcriptEvent: TranscriptEvent = {
      type: "transcript",
      id: crypto.randomUUID(),
      roomId,
      agentId,
      agentName: bindings.agent.name,
      content: normalizedResponse,
      timestamp: spokenAt.toISOString(),
      accentColor: bindings.agent.accentColor,
      wasFiltered: responseWasFiltered,
    };

    await bindings.publishTranscript(transcriptEvent);
    bindings.contextManager.addEntry({
      agentName: transcriptEvent.agentName,
      content: transcriptEvent.content,
      timestamp: transcriptEvent.timestamp,
    });

    bindings.logger.info(
      {
        agentId,
        roomId,
        turnCount: turnCount + 1,
        wasFiltered: responseWasFiltered,
      },
      "Completed agent speech turn in speak node.",
    );

    const { type: _type, ...transcriptEntry } = transcriptEvent;

    nextState = {
      status: "listening",
      lastSpokeAt: spokeAt,
      turnCount: turnCount + 1,
      isFloorHolder: false,
      rollingTranscript: [...state.rollingTranscript, transcriptEntry],
      currentResponse: null,
      currentResponseWasFiltered: false,
    };
  } catch (error) {
    pendingError = error;

    bindings.logger.error(
      {
        agentId,
        err: error,
        roomId,
      },
      "Agent speech turn failed in speak node.",
    );
  }

  try {
    await bindings.finalizeTurn({
      roomId,
      agentId,
      spokeAt,
    });
  } catch (finalizeError) {
    if (pendingError !== undefined) {
      throw pendingError;
    }

    throw finalizeError;
  }

  if (pendingError !== undefined) {
    throw pendingError;
  }

  if (!nextState) {
    throw new Error("speak node did not produce a next state.");
  }

  return nextState;
}

/**
 * Creates the `speak` node with the supplied runtime bindings.
 *
 * @param bindings - Caller-owned dependencies for graph side effects.
 * @returns A LangGraph node that synthesizes, plays, and publishes one turn.
 */
export function createSpeakNode(bindings: AgentGraphBindings) {
  return async function speakNode(
    state: AgentGraphState,
  ): Promise<Partial<AgentGraphState>> {
    const roomId = normalizeRequiredText(state.roomId, "state.roomId");
    const agentId = normalizeRequiredText(state.agentId, "state.agentId");

    if (roomId !== bindings.roomId) {
      throw new Error(
        `Graph state roomId "${roomId}" does not match bindings.roomId "${bindings.roomId}".`,
      );
    }

    const currentResponse = normalizeRequiredText(
      state.currentResponse ?? "",
      "state.currentResponse",
    );

    return await executeSpeakTurn(
      bindings,
      state,
      currentResponse,
      state.currentResponseWasFiltered,
    );
  };
}
