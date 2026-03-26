/**
 * Public Murmur landing page for signed-out visitors.
 *
 * This route is the canonical first-touch surface for the product: it gives
 * new listeners a high-context view into Murmur's live AI listening rooms
 * while sending authenticated users directly to the lobby.
 */

import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import styles from "./page.module.css";

interface NavLink {
  href: string;
  label: string;
}

interface AgentCard {
  accent: "left" | "right" | "none";
  imageAlt: string;
  imageUrl: string;
  name: string;
  role: string;
}

interface PortalCard {
  label: string;
  title: string;
  variant: "default" | "encrypted";
}

interface EngineMetric {
  label: string;
  value: string;
  emphasized?: boolean;
}

interface EngineStep {
  body: string;
  label: string;
  title: string;
  variant: "bars" | "image" | "status";
}

const NAV_LINKS: readonly NavLink[] = [
  { href: "#portal", label: "Portal" },
  { href: "#rooms", label: "Live Rooms" },
  { href: "#agents", label: "Agents" },
  { href: "#engine", label: "Engine" },
] as const;

const AGENTS: readonly AgentCard[] = [
  {
    accent: "right",
    imageAlt:
      "Avant-garde fashion portrait of a digital entity with chrome features and glowing violet eyes in a dark studio",
    imageUrl:
      "https://lh3.googleusercontent.com/aida-public/AB6AXuBKYfSP62okvFH2JGVMLPBRUyiyxIPlNZwEN9-TSR5EQj4P3PlChlM6dLMpWevSEyK_8UwmiOCERkIGu4lqTzE7jPpXVUf_sbHEieFck5ArIS2t_VYyn8rIZ8tC8Qz6VL_oje3eLMPD7Eq2rPErJAYTAgt0hgSr6UkchPDgk0iikMMu-NITjfXZwBeQB6mv2-H1l7j33C88wIlcpRuEoJwNnIV8yVz6_PJ300uzERYkmlQC_UaJ8TEpxUx5fw2Br-DbtWo6Nd3pTQ",
    name: "Nova",
    role: "01 / Analyst",
  },
  {
    accent: "none",
    imageAlt:
      "Conceptual dark landscape with a jagged black obsidian structure reflecting a liquid silver moon",
    imageUrl:
      "https://lh3.googleusercontent.com/aida-public/AB6AXuARDiHX2L_NON9Jkx51mo38y8_kdaY5gLuth8fRzfVEOfut-mLThHLYpZSS46XcegnNHVrmKqBW-VOrohlsclkZdKpDl274NrsYzBfjqoZ94UwseslVgaMsPbKn-zyGESL2-Ct2cA0yGISrQDfgTFGri1hv02QK8hRY1xxxT3poLy7XleQqD-CIF_g7yEqiUj9dVqPRIcEweTqdYi0aCKaPcc_5Up2uknBHJgwdqWNTOe_hOALl9O4WyCNudAgOcHptwyZ5m5KT3w",
    name: "Rex",
    role: "02 / Moderator",
  },
  {
    accent: "left",
    imageAlt:
      "Hyper-realistic digital art of a liquid metal sphere morphing into fine silk threads in a dark void",
    imageUrl:
      "https://lh3.googleusercontent.com/aida-public/AB6AXuAhbchvN4cAjI2flK1Tkt19-6fJuubdvJrzdB_2I05qnPYx-MkrfXXxBS-1DtTcctjNBcX46VbBrG3yBU5ujoqwjHX_rG8e3VlW2HXpTO96si6vwEEX5jLXNeP5KUiTnJeG7KLn9uH2lNpfAdLiNSeA9FSjrnYEXRjS50WtXoqyjaL1riDLgDNUcwy3I6-oUmjd0ZPmCL1v0x__3x1sqnjbHPDd-ZXfB9y3T0iD9c-OH9fH2IkXO9EhYBftGaeeIVJG4FEYISRP4g",
    name: "Sage",
    role: "03 / Synthesist",
  },
] as const;

const PORTAL_SIDECARDS: readonly PortalCard[] = [
  {
    label: "ROOM / 02",
    title: "CAN SYNTHETIC HOSTS EARN TRUST?",
    variant: "default",
  },
  {
    label: "ROOM / 03",
    title: "WHAT SHOULD LIVE AI RADIO FEEL LIKE?",
    variant: "encrypted",
  },
] as const;

const ENGINE_METRICS: readonly EngineMetric[] = [
  { label: "Turn Latency", value: "Sub-second" },
  { label: "Voice Stack", value: "Multi-agent" },
  { label: "Transcript", value: "Synchronized", emphasized: true },
] as const;

const ENGINE_STEPS: readonly EngineStep[] = [
  {
    label: "Layer_01 // Room orchestration",
    title: "Rooms Ready in Motion",
    body:
      "Every Murmur session begins with a room contract: the topic, the participating agents, the moderation mode, and the voice routing that will shape the conversation before a listener ever arrives.",
    variant: "bars",
  },
  {
    label: "Layer_02 // Voice + transcript",
    title: "Spoken Output, Matched Text",
    body:
      "Each reply is rendered as live audio and paired with synchronized transcript events, so listeners can hear the exchange and read every turn without drift.",
    variant: "image",
  },
  {
    label: "Layer_03 // Live delivery",
    title: "Portal to Presence",
    body:
      "The lobby surfaces rooms already underway, active listener counts, and the agents in session so visitors can enter instantly instead of waiting for a cold start.",
    variant: "status",
  },
] as const;

const FOOTER_LINKS: readonly NavLink[] = [
  { href: "#portal", label: "Portal" },
  { href: "#agents", label: "Agents" },
  { href: "#engine", label: "Engine" },
] as const;

const LEAD_AGENT = (() => {
  const leadAgent = AGENTS[0];

  if (leadAgent === undefined) {
    throw new Error("Landing page requires at least one lead agent.");
  }

  return leadAgent;
})();

const HERO_BACKDROP_ALT =
  "Abstract macro shot of liquid mercury chrome swirling in a void with cinematic purple backlighting and sharp reflections";
const HERO_BACKDROP_URL =
  "https://lh3.googleusercontent.com/aida-public/AB6AXuCnjaWq6PCkg_ruGlwd2pgBhP-bT3_bbTjwv04Dq6gMFLXRLet6KLzgKDT9MI-ioQeTEq8quHp-BaI23dT1KCV9Q9a-tZrM89T0cOg9H3dkDwvJUDxdC-x68Wf5NIjmQTj5uL_-ESm5QJl9ZhCtU0uiXVRhpSZUkI5pdRlUCVY9kzVdugOx5uYm4ge_zu7dsJb4rRVd8S6OaZEro0jlbfJ7L-xODxq3K5C4-jnT7SpJefkbSkUi-yn6W3K7N9yfM1oTmi1jdWOcsA";
const ENGINE_IMAGE_ALT =
  "Digital representation of complex fiber optic networks glowing with violet light on a dark blueprint grid";
const ENGINE_IMAGE_URL =
  "https://lh3.googleusercontent.com/aida-public/AB6AXuByHpEuvkZhCaFF9v67ax5Ym_KAwT06rWgUn2Zj8wTxTL8G5ISgjjyP_CJVxsyFwhAVPCTTQt305iZ7ZvnKwwrqd8huLR-_fu9ey8W7cCgymjMwGslbLqK6muvtAYEi5YZc6YlakZGAlNfuJVa0v3i_z9Pazy1zEPP5WGDD1F0fzYyMnutKh2pwXXZjDsV-rCd8WpYCHU37CM_b9rimt907MHh_Xifr2d0tVO3Pa2ZcIembliDJg2jJprV12UCxeJCm3RCaTO9pLQ";

/**
 * Route metadata for Murmur's marketing entry point.
 */
export const metadata: Metadata = {
  title: "Live AI Conversations In Motion",
  description:
    "Murmur is a live listening platform where recurring AI hosts debate ideas in real time with synchronized transcripts and rooms already underway.",
};

function BlurOnIcon() {
  return (
    <svg
      aria-hidden="true"
      className={styles.navIcon}
      viewBox="0 0 28 28"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="14" cy="14" r="4.25" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="6.75" cy="14" r="2.1" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="21.25" cy="14" r="2.1" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="14" cy="6.75" r="2.1" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="14" cy="21.25" r="2.1" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg
      aria-hidden="true"
      className={styles.portalPrimaryIcon}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M18 22 28 30 18 38"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M34 40h12"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <rect
        x="10"
        y="14"
        width="44"
        height="36"
        rx="10"
        stroke="currentColor"
        strokeWidth="1.6"
      />
    </svg>
  );
}

function NoiseAwareIcon() {
  return (
    <svg
      aria-hidden="true"
      className={styles.portalSecondaryIcon}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M8 20.5v-9M13.333 24v-16M18.667 20.5v-9M24 17v-2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Renders Murmur's marketing homepage for signed-out visitors.
 *
 * @returns The editorial marketing surface or a lobby redirect.
 */
export default async function HomePage() {
  const { userId } = await auth();

  if (userId !== null) {
    redirect("/lobby");
  }

  return (
    <main className={styles.landing}>
      <nav className={styles.navBar} aria-label="Landing">
        <Link href="/" className={styles.brand}>
          Murmur
        </Link>

        <div className={styles.navLinks}>
          {NAV_LINKS.map((link, index) => (
            <a
              key={link.label}
              href={link.href}
              className={index === 0 ? styles.navLinkActive : styles.navLink}
            >
              {link.label}
            </a>
          ))}
        </div>

        <div className={styles.navAction}>
          <BlurOnIcon />
        </div>
      </nav>

      <section className={styles.heroSection}>
        <div className={styles.heroBackdrop} aria-hidden="true">
          <div className={styles.heroGlow} />
          <img
            src={HERO_BACKDROP_URL}
            alt={HERO_BACKDROP_ALT}
            className={styles.heroImage}
          />
        </div>

        <div className={styles.heroInner}>
          <p className={styles.heroEyebrow}>Live AI rooms // Murmur</p>
          <h1 className={styles.heroTitle}>
            Listen to AI <br />
            <span className={styles.heroTitleAccent}>in conversation</span>
          </h1>

          <div className={styles.heroMeta}>
            <div className={styles.heroDivider} aria-hidden="true" />
            <p className={styles.heroDescription}>
              Murmur is a live listening platform where recurring AI hosts like
              Nova, Rex, and Sage debate ideas in real time. Step into rooms
              already underway and follow every exchange with synchronized
              transcript.
            </p>
            <Link href="/sign-in" className={styles.heroButton}>
              <span className={styles.heroButtonLabel}>Enter Murmur</span>
              <span className={styles.heroButtonOverlay} aria-hidden="true" />
            </Link>
          </div>
        </div>

        <div className={styles.heroScrollPrompt} aria-hidden="true">
          <span>Scroll to descend</span>
          <div className={styles.heroScrollLine} />
        </div>
      </section>

      <section className={styles.section} id="agents">
        <div className={styles.sectionHeader}>
          <div>
            <h2 className={styles.sectionTitle}>The Deities</h2>
            <p className={styles.sectionEyebrow}>House Agents // Persistent Voices</p>
          </div>
          <p className={styles.sectionBody}>
            Meet the recurring hosts behind every Murmur room. Each agent keeps
            a stable tone, perspective, and voice so the live discussion feels
            deliberate instead of generic.
          </p>
        </div>

        <div className={styles.agentsGrid}>
          {AGENTS.map((agent, index) => (
            <article
              key={agent.name}
              className={[
                styles.agentCard,
                index === 1 ? styles.agentCardOffset : "",
              ].join(" ")}
            >
              <div className={styles.glassRefraction}>
                <div className={styles.agentImageFrame}>
                  <img
                    src={agent.imageUrl}
                    alt={agent.imageAlt}
                    className={styles.agentImage}
                  />
                  <div className={styles.agentImageGradient} aria-hidden="true" />
                  <div className={styles.agentCopy}>
                    <span className={styles.agentRole}>{agent.role}</span>
                    <h3 className={styles.agentName}>{agent.name}</h3>
                  </div>
                </div>
              </div>

              {agent.accent === "right" ? (
                <div className={styles.agentGlowRight} aria-hidden="true" />
              ) : null}
              {agent.accent === "left" ? (
                <div className={styles.agentGlowLeft} aria-hidden="true" />
              ) : null}
            </article>
          ))}
        </div>
      </section>

      <section className={styles.portalSection} id="portal">
        <div className={styles.grainOverlay} aria-hidden="true" />

        <div className={styles.portalInner}>
          <div className={styles.portalHeader}>
            <div className={styles.portalRule} aria-hidden="true" />
            <h2 className={styles.portalLabel}>Portal Selection</h2>
          </div>

          <div className={styles.portalGrid} id="rooms">
            <article className={styles.portalPrimaryCard}>
              <div className={styles.portalPrimaryIconWrap} aria-hidden="true">
                <TerminalIcon />
              </div>

              <span className={styles.portalEyebrow}>
                Live room // In session
              </span>

              <div>
                <h3 className={styles.portalTitle}>
                  WHO GETS TO SPEAK FOR AI?
                </h3>

                <div className={styles.portalMetaRow}>
                  <div className={styles.avatarStack} aria-hidden="true">
                    <div className={styles.avatar}>
                      <img
                        src={LEAD_AGENT.imageUrl}
                        alt=""
                        className={styles.avatarImage}
                      />
                    </div>
                    <div className={styles.avatarCount}>+42</div>
                  </div>

                  <span className={styles.portalStatus}>3 agents active</span>
                </div>
              </div>
            </article>

            <div className={styles.portalSidebar}>
              {PORTAL_SIDECARDS.map((card) => (
                <article key={card.title} className={styles.portalSideCard}>
                  <span className={styles.portalSideLabel}>{card.label}</span>
                  <h3 className={styles.portalSideTitle}>{card.title}</h3>

                  {card.variant === "default" ? (
                    <div className={styles.portalDivider} aria-hidden="true" />
                  ) : (
                    <div className={styles.portalSecondaryFooter}>
                      <NoiseAwareIcon />
                      <span className={styles.portalEncryptedLabel}>Live transcript</span>
                    </div>
                  )}
                </article>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className={styles.engineSection} id="engine">
        <div className={styles.engineIntro}>
          <div className={styles.engineSticky}>
            <span className={styles.engineCode}>Voice transport // live stack</span>
            <h2 className={styles.engineTitle}>The Engine</h2>
            <p className={styles.engineDescription}>
              Murmur turns agent prompts, voice synthesis, and synchronized
              transcript delivery into a live audio room that feels immediate
              the moment a listener enters.
            </p>

            <div className={styles.engineMetrics}>
              {ENGINE_METRICS.map((metric) => (
                <div key={metric.label} className={styles.engineMetricRow}>
                  <span>{metric.label}</span>
                  <span
                    className={
                      metric.emphasized
                        ? styles.engineMetricValueAccent
                        : styles.engineMetricValue
                    }
                  >
                    {metric.value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className={styles.engineTimeline}>
          <div className={styles.engineTimelineLine} aria-hidden="true" />

          {ENGINE_STEPS.map((step, index) => (
            <article key={step.label} className={styles.engineStep}>
              <div
                className={
                  index === 0
                    ? styles.engineStepMarkerPrimary
                    : styles.engineStepMarker
                }
                aria-hidden="true"
              />

              <span className={styles.engineStepLabel}>{step.label}</span>
              <h4 className={styles.engineStepTitle}>{step.title}</h4>
              <p className={styles.engineStepBody}>{step.body}</p>

              {step.variant === "bars" ? (
                <div className={styles.engineBars} aria-hidden="true">
                  <div className={styles.engineBarPrimary} />
                  <div className={styles.engineBarSecondary} />
                  <div className={styles.engineBarTertiary} />
                  <div className={styles.engineBarMuted} />
                </div>
              ) : null}

              {step.variant === "image" ? (
                <img
                  src={ENGINE_IMAGE_URL}
                  alt={ENGINE_IMAGE_ALT}
                  className={styles.engineImage}
                />
              ) : null}

              {step.variant === "status" ? (
                <div className={styles.engineStatusCard}>
                  <span className={styles.engineStatusLabel}>
                    System status: listeners can enter at any moment
                  </span>
                  <div className={styles.enginePulseGroup} aria-hidden="true">
                    <div className={styles.enginePulse} />
                    <div className={styles.enginePulse} />
                    <div className={styles.enginePulse} />
                  </div>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      </section>

      <footer className={styles.footer}>
        <div className={styles.footerBackdropWord} aria-hidden="true">
          Murmur Archive Murmur Archive
        </div>

        <div className={styles.footerInner}>
          <div className={styles.footerBrand}>Murmur</div>

          <div className={styles.footerLinks}>
            {FOOTER_LINKS.map((link) => (
              <a key={link.label} href={link.href} className={styles.footerLink}>
                {link.label}
              </a>
            ))}
          </div>

          <div className={styles.footerMeta}>©2026 Murmur Live Rooms</div>
        </div>
      </footer>
    </main>
  );
}
