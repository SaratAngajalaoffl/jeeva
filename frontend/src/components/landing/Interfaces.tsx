import { Fragment } from "react";
import { Reveal } from "./Reveal";
import { SpotlightCard } from "./SpotlightCard";

/**
 * The architecture, as the three seams it's actually built from. Data flows
 * left to right — where the numbers come from, who reads them, where the
 * answer lands — with a pulse travelling along each connector.
 *
 * Every panel names the interface and what currently implements it, so the
 * shipped setup reads as one configuration rather than the whole product.
 */

const INTERFACES = [
  {
    name: "MarketDataSource",
    role: "Where the numbers come from",
    signature: "fetch(market) → price · liquidity · spread",
    body: "Feeds the recorded history every decision is made against. Point it at an exchange feed, your own store, or a recorded window you want to replay.",
    ships: ["Hyperliquid"],
  },
  {
    name: "DecisionMaker",
    role: "Who picks a side",
    signature: "decide(state) → long · short · flat",
    body: "Anything that can look at a market and answer with a direction: a model, a set of rules, an indicator, a service of your own. It only has to answer the question.",
    ships: ["Jev"],
  },
  {
    name: "WalletAdapter",
    role: "Where the answer lands",
    signature: "position() · open() · close()",
    body: "Carries out the decision. Simulated fills for evaluation, a real exchange wallet for live trading, or a venue you add yourself.",
    ships: ["Paper wallet", "Hyperliquid"],
  },
];

function Connector({ delay }: { delay: number }) {
  return (
    <div
      aria-hidden
      className="relative hidden w-16 shrink-0 items-center self-center lg:flex"
    >
      <div className="h-px w-full bg-gradient-to-r from-surface-1 via-overlay-0 to-surface-1" />
      <div className="absolute inset-0 overflow-hidden">
        <div
          className="jv-flow absolute top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-ember shadow-[0_0_10px_2px_rgb(255_59_59/0.6)]"
          style={{ animationDelay: `${delay}s` }}
        />
      </div>
    </div>
  );
}

export function Interfaces() {
  return (
    <div>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-stretch lg:gap-0">
        {INTERFACES.map((item, index) => (
          <Fragment key={item.name}>
            {index > 0 && <Connector delay={(index - 1) * 0.5} />}
            <Reveal
              delay={index * 0.12}
              className="min-w-0 flex-1"
              from={index === 0 ? "left" : index === 2 ? "right" : "up"}
            >
              <SpotlightCard
                className="h-full p-6"
                contentClassName="flex h-full flex-col"
              >
                <div className="text-[11px] font-medium uppercase tracking-wider text-subtext-0">
                  {item.role}
                </div>
                <h3 className="mt-1.5 font-mono text-base font-semibold tracking-tight text-text">
                  {item.name}
                </h3>
                <code className="mt-3 block overflow-x-auto rounded-lg border border-surface-1 bg-crust/70 px-3 py-2 font-mono text-[11px] text-peach">
                  {item.signature}
                </code>
                <p className="mt-4 text-sm leading-relaxed text-subtext-1">
                  {item.body}
                </p>
                <div className="mt-auto flex flex-wrap items-center gap-2 pt-5">
                  <span className="text-[11px] uppercase tracking-wider text-subtext-0">
                    Ships with
                  </span>
                  {item.ships.map((implementation) => (
                    <span
                      key={implementation}
                      className="rounded-full border border-surface-2 bg-mantle px-2.5 py-0.5 text-[11px] font-medium text-subtext-1"
                    >
                      {implementation}
                    </span>
                  ))}
                </div>
              </SpotlightCard>
            </Reveal>
          </Fragment>
        ))}
      </div>

      <Reveal
        delay={0.2}
        className="mt-8 flex flex-col items-center gap-2 text-center"
      >
        <p className="max-w-2xl text-pretty text-sm leading-relaxed text-subtext-1">
          Implement one of these, register it, and pick it per market from the
          dashboard. The loop around them doesn&apos;t change — which is what
          makes a new strategy or a new exchange an addition rather than a
          rewrite.
        </p>
      </Reveal>
    </div>
  );
}
