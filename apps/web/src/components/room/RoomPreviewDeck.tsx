"use client";

/**
 * Read-only live-room presentation used by the current `/room/[id]` scaffold.
 *
 * This client component assembles the room header, stage, and transcript
 * surfaces into a polished preview deck without pulling in any realtime join
 * logic before the dedicated live-room assembly step lands.
 */

import { startTransition, useState } from "react";
import { useRouter } from "next/navigation";

import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import type { Room, TranscriptEntry } from "@/types";

import AgentStage from "./AgentStage";
import RoomHeader from "./RoomHeader";
import TranscriptPanel from "./TranscriptPanel";

export interface RoomPreviewDeckProps {
  previewTranscript: readonly TranscriptEntry[];
  room: Room;
}

/**
 * Returns the current host agent name, if the room has one assigned.
 *
 * @param room - Room being rendered inside the preview deck.
 * @returns The host name or a fallback label.
 */
function getHostName(room: Room): string {
  return room.agents.find((agent) => agent.role === "host")?.name ?? "Murmur";
}

/**
 * Maps the canonical room format to concise explanatory copy.
 *
 * @param room - Room being rendered inside the preview deck.
 * @returns Short format-specific presentation copy.
 */
function getFormatDescription(room: Room): string {
  return room.format === "moderated"
    ? "A host-led cadence keeps the debate focused while still giving each voice space to push."
    : "A looser floor gives the agents more room to challenge, interrupt, and self-organize.";
}

/**
 * Returns the most relevant active speaker for the static preview.
 *
 * The final transcript line is treated as the current focal voice so the stage
 * looks alive even before the realtime LiveKit speaker mapping is connected.
 *
 * @param room - Room being rendered inside the preview deck.
 * @param previewTranscript - Static transcript entries shown beside the stage.
 * @returns The current active speaker id or `null`.
 */
function getPreviewActiveSpeakerId(
  room: Room,
  previewTranscript: readonly TranscriptEntry[],
): string | null {
  return (
    previewTranscript[previewTranscript.length - 1]?.agentId ??
    room.agents.find((agent) => agent.role === "host")?.id ??
    null
  );
}

/**
 * Renders the read-only room listening deck used by the current scaffold route.
 *
 * @param props - Room data and the static transcript preview to present.
 * @returns A client-rendered preview of the eventual live room composition.
 */
export default function RoomPreviewDeck({
  previewTranscript,
  room,
}: Readonly<RoomPreviewDeckProps>) {
  const router = useRouter();
  const [isLeaving, setIsLeaving] = useState(false);
  const hostName = getHostName(room);
  const activeSpeakerId = getPreviewActiveSpeakerId(room, previewTranscript);

  /**
   * Returns the listener to the lobby while surfacing the same leave affordance
   * the eventual realtime room route will use.
   */
  function handleLeaveRoom() {
    startTransition(() => {
      setIsLeaving(true);
      router.push("/lobby");
    });
  }

  return (
    <div className="room-live-preview">
      <RoomHeader
        title={room.title}
        topic={room.topic}
        listenerCount={room.listenerCount}
        isLeaving={isLeaving}
        onLeave={handleLeaveRoom}
      />

      <div className="room-layout">
        <div className="room-preview-stack">
          <AgentStage
            agents={room.agents}
            activeSpeakerId={activeSpeakerId}
            className="fade-up"
          />

          <Card className="room-preview-brief fade-up">
            <div className="room-preview-brief__top">
              <div className="room-preview-brief__intro">
                <span className="section-label">Room dynamics</span>
                <p>
                  The room is framed as a clean listening surface: strong stage
                  hierarchy, readable live text, and just enough context to make
                  the discussion feel intentional.
                </p>
              </div>

              <Badge variant="format" format={room.format} />
            </div>

            <div className="room-preview-brief__grid">
              <div className="room-preview-brief__item">
                <span className="mono">Host lead</span>
                <p>
                  {hostName} anchors transitions and keeps the room coherent when
                  the debate sharpens.
                </p>
              </div>

              <div className="room-preview-brief__item">
                <span className="mono">Format</span>
                <p>{getFormatDescription(room)}</p>
              </div>

              <div className="room-preview-brief__item">
                <span className="mono">Audience</span>
                <p>
                  {room.listenerCount} listeners are already in the room, giving
                  the conversation real crowd pressure from the first turn.
                </p>
              </div>
            </div>
          </Card>
        </div>

        <TranscriptPanel
          entries={previewTranscript}
          isConnected
          className="fade-up"
        />
      </div>
    </div>
  );
}
