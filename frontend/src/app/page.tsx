import { Fragment } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowLeftRight,
  ArrowRight,
  Layers,
  Repeat,
  ScrollText,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import Logo from "@/components/Logo";
import { AxisMatrix } from "@/components/landing/AxisMatrix";
import { DecisionCycle } from "@/components/landing/DecisionCycle";
import { LandingNav } from "@/components/landing/LandingNav";
import { Reveal } from "@/components/landing/Reveal";
import { SignalPanel } from "@/components/landing/SignalPanel";
import { SpotlightCard } from "@/components/landing/SpotlightCard";
import { StateBlock } from "@/components/landing/StateBlock";
import { TickerTape } from "@/components/landing/TickerTape";

const HEADLINE = [
  { word: "Hyperliquid" },
  { word: "perps," },
  { word: "traded" },
  { word: "on" },
  { word: "a" },
  { word: "logged", accent: true },
  { word: "decision.", accent: true },
];

const HERO_STATS = [
  { value: "3", label: "decision makers" },
  { value: "2", label: "execution paths" },
  { value: "1,000", label: "samples per decision" },
  { value: "5", label: "failures → auto-flatten" },
];

const FEATURES = [
  {
    icon: Activity,
    title: "Tracks the market",
    body: "For every PERP with sampling on, Jeeva continuously records price, open interest, volume and spread — the history every later decision is made against.",
  },
  {
    icon: Sparkles,
    title: "Asks Jev, not a chat loop",
    body: "One structured Choice question per tick against a compact text state. Back comes a target direction, a confidence, and a probability for each outcome.",
  },
  {
    icon: ArrowLeftRight,
    title: "Moves to match",
    body: "Target direction is diffed against the live position: open, close, or flip. Repeating the same direction is a no-op — no pyramiding, ever.",
  },
  {
    icon: SlidersHorizontal,
    title: "Tuned per market",
    body: "Frequency, leverage, decision maker, sampling and trading are all per-PERP switches. Run one market hourly and another every minute.",
  },
  {
    icon: Repeat,
    title: "No restarts",
    body: "Config lives in MongoDB and the engine watches it with change streams. Flip a switch on the dashboard and the next cycle already sees it.",
  },
  {
    icon: ScrollText,
    title: "Auditable by default",
    body: "Every tick writes its context, decision, action and error — including the ticks that fail. Each position traces back to the state that produced it.",
  },
];

const SAFETY = [
  {
    icon: ShieldCheck,
    title: "Mock until you say otherwise",
    body: "A fresh deployment and every new market start against a simulated wallet. Real Hyperliquid orders need an explicit switch to live and configured wallet credentials — both, not either.",
  },
  {
    icon: AlertTriangle,
    title: "Five strikes, then flat",
    body: "If a PERP's cycle fails five times in a row — bad data, a down decision API, a rejected order — Jeeva force-flattens that position rather than leaving it unmanaged.",
  },
  {
    icon: Layers,
    title: "Independent axes",
    body: "Which model decides and where the order lands are separate settings. Real Jev decisions can run against the mock wallet indefinitely.",
  },
];

function SectionHeading({
  eyebrow,
  title,
  body,
}: {
  eyebrow: string;
  title: string;
  body?: string;
}) {
  return (
    <Reveal className="mx-auto max-w-2xl text-center">
      <span className="inline-flex items-center gap-2 rounded-full border border-surface-1 bg-surface-0/50 px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-subtext-0">
        {eyebrow}
      </span>
      <h2 className="mt-4 text-balance text-3xl font-semibold tracking-tight text-text sm:text-4xl">
        {title}
      </h2>
      {body && (
        <p className="mt-4 text-pretty text-base leading-relaxed text-subtext-1">
          {body}
        </p>
      )}
    </Reveal>
  );
}

export default function Home() {
  return (
    <>
      <LandingNav />

      <main className="flex flex-col">
        {/* Hero ------------------------------------------------------------ */}
        <section className="relative px-6 pb-20 pt-32 sm:pt-40">
          <div className="mx-auto grid max-w-6xl items-center gap-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-10">
            <div className="flex flex-col items-start">
              <div
                className="jv-fade-up inline-flex items-center gap-2 rounded-full border border-surface-1 bg-surface-0/50 py-1 pl-1 pr-3 backdrop-blur"
                style={{ animationDelay: "0.05s" }}
              >
                <span className="rounded-full bg-ember/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-ember">
                  Mock first
                </span>
                <span className="text-xs text-subtext-1">
                  Live orders only when you flip the switch
                </span>
              </div>

              <h1 className="mt-6 text-balance text-[2.6rem] font-semibold leading-[1.05] tracking-tight text-text sm:text-6xl">
                {HEADLINE.map(({ word, accent }, index) => (
                  <Fragment key={word}>
                    <span
                      className="jv-rise inline-block"
                      style={{ animationDelay: `${0.12 + index * 0.07}s` }}
                    >
                      {accent ? (
                        <span className="bg-gradient-to-br from-peach via-ember to-ember bg-clip-text text-transparent">
                          {word}
                        </span>
                      ) : (
                        word
                      )}
                    </span>{" "}
                  </Fragment>
                ))}
              </h1>

              <p
                className="jv-fade-up mt-6 max-w-xl text-pretty text-lg leading-relaxed text-subtext-1"
                style={{ animationDelay: "0.55s" }}
              >
                Jeeva watches Hyperliquid perpetual futures, periodically asks
                an AI decision model whether each market should be long, short
                or flat, and moves the position to match — against a paper
                wallet until you decide otherwise.
              </p>

              <div
                className="jv-fade-up mt-9 flex flex-wrap items-center gap-3"
                style={{ animationDelay: "0.68s" }}
              >
                <Link
                  href="/login"
                  className="group relative inline-flex items-center gap-2 overflow-hidden rounded-xl bg-ember px-6 py-3 text-sm font-semibold text-primary-foreground shadow-lg shadow-ember/25 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-ember/35"
                >
                  <span
                    aria-hidden
                    className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/30 to-transparent transition-transform duration-700 group-hover:translate-x-full"
                  />
                  <span className="relative">Open the dashboard</span>
                  <ArrowRight
                    size={16}
                    className="relative transition-transform duration-300 group-hover:translate-x-1"
                  />
                </Link>
                <a
                  href="#cycle"
                  className="inline-flex items-center gap-2 rounded-xl border border-surface-1 bg-surface-0/40 px-6 py-3 text-sm font-medium text-text backdrop-blur transition-colors hover:border-ember/50 hover:text-ember"
                >
                  See the decision cycle
                </a>
              </div>

              <dl
                className="jv-fade-up mt-12 grid w-full grid-cols-2 gap-x-6 gap-y-5 border-t border-surface-1 pt-8 sm:grid-cols-4"
                style={{ animationDelay: "0.8s" }}
              >
                {HERO_STATS.map((stat) => (
                  <div key={stat.label} className="flex flex-col">
                    <dt className="order-2 mt-1 text-xs leading-snug text-subtext-0">
                      {stat.label}
                    </dt>
                    <dd className="order-1 text-2xl font-semibold tracking-tight text-text">
                      {stat.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>

            <SignalPanel />
          </div>
        </section>

        <TickerTape />

        {/* What it does ---------------------------------------------------- */}
        <section id="what-it-does" className="scroll-mt-24 px-6 py-24 sm:py-32">
          <div className="mx-auto max-w-6xl">
            <SectionHeading
              eyebrow="What it does"
              title="An operator's trading loop, not a black box"
              body="Six things happen on repeat. All six are visible on the dashboard, and all six are yours to switch off."
            />

            <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((feature, index) => {
                const Icon = feature.icon;
                return (
                  <Reveal key={feature.title} delay={(index % 3) * 0.08}>
                    <SpotlightCard className="h-full p-6">
                      <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-surface-1 bg-mantle text-ember transition-colors duration-500 group-hover:border-ember/40 group-hover:text-peach">
                        <Icon size={18} />
                      </span>
                      <h3 className="mt-4 text-base font-semibold tracking-tight text-text">
                        {feature.title}
                      </h3>
                      <p className="mt-2 text-sm leading-relaxed text-subtext-1">
                        {feature.body}
                      </p>
                    </SpotlightCard>
                  </Reveal>
                );
              })}
            </div>
          </div>
        </section>

        {/* The decision cycle ---------------------------------------------- */}
        <section
          id="cycle"
          className="scroll-mt-24 border-y border-surface-1 bg-mantle/30 px-6 py-24 sm:py-32"
        >
          <div className="mx-auto max-w-6xl">
            <SectionHeading
              eyebrow="The decision cycle"
              title="One tick, six steps, every time"
              body="Each trading-enabled market runs its own independent loop on its own frequency. Nothing is shared but the wallet."
            />
            <div className="mt-16">
              <DecisionCycle />
            </div>
          </div>
        </section>

        {/* What Jev sees --------------------------------------------------- */}
        <section className="px-6 py-24 sm:py-32">
          <div className="mx-auto max-w-6xl">
            <SectionHeading
              eyebrow="What Jev sees"
              title="A sentence, not a database dump"
              body="The engine compresses the whole sampled window into one line of text, asks a single question, and writes the structured answer straight to the log."
            />
            <div className="mt-14">
              <StateBlock />
            </div>
          </div>
        </section>

        {/* Axes ------------------------------------------------------------ */}
        <section
          id="axes"
          className="scroll-mt-24 border-y border-surface-1 bg-mantle/30 px-6 py-24 sm:py-32"
        >
          <div className="mx-auto max-w-6xl">
            <SectionHeading
              eyebrow="Two independent axes"
              title="Pick who decides. Pick where it lands."
              body="The decision maker and the execution path are separate choices — which is how you get real intelligence trading a wallet that cannot lose anything."
            />
            <Reveal className="mt-14" from="zoom">
              <AxisMatrix />
            </Reveal>
          </div>
        </section>

        {/* Safety ---------------------------------------------------------- */}
        <section id="safety" className="scroll-mt-24 px-6 py-24 sm:py-32">
          <div className="mx-auto max-w-6xl">
            <SectionHeading
              eyebrow="Safety"
              title="The boring guarantees"
              body="An always-on trading process should be dull in exactly three ways."
            />

            <div className="mt-14 grid gap-4 lg:grid-cols-3">
              {SAFETY.map((item, index) => {
                const Icon = item.icon;
                return (
                  <Reveal key={item.title} delay={index * 0.1}>
                    <SpotlightCard className="h-full p-7">
                      <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-peach/25 bg-peach/10 text-peach">
                        <Icon size={20} />
                      </span>
                      <h3 className="mt-5 text-lg font-semibold tracking-tight text-text">
                        {item.title}
                      </h3>
                      <p className="mt-2.5 text-sm leading-relaxed text-subtext-1">
                        {item.body}
                      </p>
                    </SpotlightCard>
                  </Reveal>
                );
              })}
            </div>
          </div>
        </section>

        {/* Closing CTA ----------------------------------------------------- */}
        <section className="px-6 pb-28">
          <Reveal from="zoom" className="mx-auto max-w-4xl">
            <div className="relative overflow-hidden rounded-3xl border border-surface-1 bg-surface-0/40 px-8 py-16 text-center backdrop-blur sm:px-16">
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0"
                style={{
                  background:
                    "radial-gradient(70% 60% at 50% 0%, rgb(255 59 59 / 0.18), transparent 70%)",
                }}
              />
              <div
                aria-hidden
                className="jv-sweep pointer-events-none absolute inset-y-0 -left-1/3 w-1/3 bg-gradient-to-r from-transparent via-text/[0.06] to-transparent"
              />
              <div className="relative">
                <h2 className="text-balance text-3xl font-semibold tracking-tight text-text sm:text-4xl">
                  Start on the paper wallet.
                </h2>
                <p className="mx-auto mt-4 max-w-md text-pretty text-base leading-relaxed text-subtext-1">
                  Enable a market, pick a decision maker, and watch the log fill
                  up. Nothing touches the real orderbook until you say so.
                </p>
                <Link
                  href="/login"
                  className="group mt-9 inline-flex items-center gap-2 rounded-xl bg-ember px-7 py-3.5 text-sm font-semibold text-primary-foreground shadow-lg shadow-ember/25 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-ember/35"
                >
                  Sign in
                  <ArrowRight
                    size={16}
                    className="transition-transform duration-300 group-hover:translate-x-1"
                  />
                </Link>
              </div>
            </div>
          </Reveal>
        </section>
      </main>

      <footer className="border-t border-surface-1 px-6 py-10">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-5 sm:flex-row">
          <div className="flex items-center gap-3">
            <Logo height={18} className="opacity-70" />
            <span className="text-xs text-subtext-0">
              AI-assisted trading for Hyperliquid perpetual futures
            </span>
          </div>
          <div className="flex items-center gap-6 text-xs text-subtext-0">
            <a
              href="https://github.com/SaratAngajalaoffl/jeeva"
              target="_blank"
              rel="noreferrer"
              className="transition-colors hover:text-text"
            >
              GitHub
            </a>
            <a
              href="https://github.com/SaratAngajalaoffl/jeeva/blob/main/LICENSE"
              target="_blank"
              rel="noreferrer"
              className="transition-colors hover:text-text"
            >
              MIT
            </a>
            <Link href="/login" className="transition-colors hover:text-text">
              Sign in
            </Link>
          </div>
        </div>
      </footer>
    </>
  );
}
