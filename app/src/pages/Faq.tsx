/**
 * FAQ page.
 *
 * Written for someone who has never used a mixer and does not want to learn cryptography. Two
 * rules held throughout: no jargon without an immediate plain explanation, and no claim that the
 * rest of the app contradicts. The protocol breaks the on-chain link and nothing more, so the
 * limits are stated here as plainly as the benefits. A user who only reads this page should come
 * away knowing that losing the note loses the money, that withdrawing immediately defeats the
 * point, and that this is unaudited software.
 */

interface FaqProps {
  onGoToDeposit: () => void;
}

/** One question. Uses native details/summary so it works without JS and is keyboard accessible. */
function Question({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <details className="group bg-zinc-800/40 rounded-xl ring-1 ring-white/[0.05] overflow-hidden">
      <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-zinc-200 hover:text-white flex items-center justify-between gap-3">
        <span>{q}</span>
        <span
          aria-hidden="true"
          className="text-zinc-500 shrink-0 transition-transform group-open:rotate-45"
        >
          +
        </span>
      </summary>
      <div className="px-4 pb-4 text-zinc-400 text-xs leading-relaxed space-y-2">{children}</div>
    </details>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="shrink-0 w-6 h-6 rounded-full bg-cyan-500/15 ring-1 ring-cyan-400/30 text-cyan-300 text-xs font-bold grid place-items-center">
        {n}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-zinc-200">{title}</p>
        <p className="text-xs text-zinc-400 leading-relaxed mt-0.5">{children}</p>
      </div>
    </div>
  );
}

export default function Faq({ onGoToDeposit }: FaqProps) {
  return (
    <div className="space-y-8">
      {/* Why */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Why would I want this?</h2>
        <p className="text-zinc-400 text-sm leading-relaxed">
          Every Solana transaction is public and permanent. Anyone who learns one of your addresses
          can scroll back through everything it ever did: what you were paid, what you bought, what
          you hold, who you send money to. Nothing expires.
        </p>
        <p className="text-zinc-400 text-sm leading-relaxed">
          That is not how money normally works. Your bank knows your salary, but your colleagues,
          your landlord and strangers on the internet do not. SornadoCash gives you back that
          ordinary level of privacy for SOL. Wanting it is not suspicious, it is the default
          everywhere else.
        </p>
      </section>

      {/* How */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">How does it work?</h2>
        <p className="text-zinc-400 text-sm leading-relaxed">
          Think of a coat check at a busy venue. You hand over your coat and get a numbered ticket.
          Later you hand back the ticket and get a coat. The attendant knows a ticket is genuine
          without needing to remember whose coat was whose.
        </p>
        <p className="text-zinc-400 text-sm leading-relaxed">
          Here the coat is a fixed amount of SOL, the ticket is your secret note, and the attendant
          is a smart contract. You deposit into a pool that already holds identical deposits from
          other people. Later you prove you hold a valid note and the pool pays out to any address
          you name.
        </p>
        <p className="text-zinc-400 text-sm leading-relaxed">
          The clever part is that the proof convinces the contract your note is real{' '}
          <strong className="text-zinc-300">without revealing which deposit it belongs to</strong>.
          That is what a zero-knowledge proof is: a way to prove a statement is true while keeping
          the details private. Your browser builds it on your device, and your note never leaves it.
        </p>
        <p className="text-zinc-400 text-sm leading-relaxed">
          So the chain records a deposit from your wallet, and later a withdrawal to some address,
          with no link between the two.
        </p>
      </section>

      {/* Step by step */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Step by step</h2>
        <div className="space-y-3.5">
          <Step n={1} title="Connect your wallet">
            Phantom or Solflare. You only need it for the deposit, not to withdraw.
          </Step>
          <Step n={2} title="Pick an amount">
            0.1, 1, 10 or 100 SOL. Amounts are fixed on purpose: if you could deposit 3.7194 SOL,
            that unusual number would identify you on the way out.
          </Step>
          <Step n={3} title="Deposit, then save your note">
            You get a long string starting with sndo_. Copy it somewhere safe, like a password
            manager. This is the step that matters most. Nobody can recover it for you, so a lost
            note means the money stays in the pool forever.
          </Step>
          <Step n={4} title="Wait">
            This is not busywork. If you deposit and withdraw minutes apart, anyone comparing the
            two lists can guess they belong together, no matter how good the proof is. Hours are
            better than minutes, days are better than hours.
          </Step>
          <Step n={5} title="Go to Withdraw and paste the note">
            Enter any destination address. A fresh, empty wallet is best. Withdrawing to a wallet
            already tied to your name gives away what you just protected.
          </Step>
          <Step n={6} title="Wait about 30 to 60 seconds">
            Your browser is building the proof. Keep the page open. When it finishes, a relayer
            submits the transaction for you.
          </Step>
          <Step n={7} title="Funds arrive">
            The destination address receives the amount minus fees. There is no on-chain trail back
            to your deposit.
          </Step>
        </div>
        <button
          onClick={onGoToDeposit}
          className="w-full py-3 btn-primary text-sm mt-2"
        >
          Start a deposit
        </button>
      </section>

      {/* Costs */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">What does it cost?</h2>
        <div className="bg-zinc-800/40 rounded-xl p-4 space-y-2 ring-1 ring-white/[0.05]">
          <div className="flex justify-between text-sm">
            <span className="text-zinc-400">Protocol fee</span>
            <span className="text-zinc-200 tnum">0.2% of the amount</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-zinc-400">Relayer fee</span>
            <span className="text-zinc-200 tnum">around 0.003 SOL</span>
          </div>
          <div className="border-t border-zinc-700 pt-2 flex justify-between text-sm">
            <span className="text-zinc-300 font-medium">On 1 SOL you receive</span>
            <span className="text-zinc-100 font-semibold tnum">about 0.995 SOL</span>
          </div>
        </div>
        <p className="text-zinc-500 text-xs leading-relaxed">
          Both are taken out of the withdrawal, not charged at deposit time. Exactly the amount you
          picked leaves your wallet when you deposit.
        </p>
      </section>

      {/* Honest limits */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">What this does not do</h2>
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 space-y-2">
          <p className="text-amber-300 text-sm font-semibold">Read this before using real money.</p>
          <p className="text-amber-400/80 text-xs leading-relaxed">
            This software has not been audited by an outside firm, and the cryptographic setup was
            generated by one person, which means that person could in principle create fake proofs
            and drain the pools. Treat it as an experiment. Do not put in more than you would be
            relaxed about losing.
          </p>
        </div>
        <ul className="text-zinc-400 text-xs leading-relaxed space-y-2 list-disc pl-4">
          <li>
            It hides the link between two on-chain transactions. It does not hide your IP address,
            so use a VPN or Tor for the withdrawal, ideally on a different network and device than
            you deposited from.
          </li>
          <li>
            It cannot help you if the pool is nearly empty. Hiding in a crowd needs a crowd.
          </li>
          <li>
            It cannot undo a mistake. There is no support desk, no password reset and no way to
            reverse a withdrawal to a wrong address.
          </li>
          <li>
            It does not make anything legal that was not legal already. It is a privacy tool, not a
            shield.
          </li>
        </ul>
      </section>

      {/* Questions */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Common questions</h2>
        <div className="space-y-2">
          <Question q="What exactly is the secret note?">
            <p>
              A short line of text that contains two random numbers only you know, plus which pool
              and amount it belongs to. It is the proof of ownership. Anyone holding it can withdraw
              your deposit, so treat it like cash.
            </p>
          </Question>

          <Question q="I lost my note. What now?">
            <p>
              The deposit cannot be recovered, by you or by anyone else. That is a consequence of
              the design rather than a policy: the contract never learns who made which deposit, so
              there is nothing to check your identity against. Before you close the deposit page,
              check that you can actually paste the note back somewhere.
            </p>
            <p>
              If your browser was interrupted mid-deposit, check the banner at the top of the app.
              Notes are saved locally until you confirm you have them.
            </p>
          </Question>

          <Question q="Why can I not choose my own amount?">
            <p>
              Because unusual amounts are self-identifying. If you deposit 7.31 SOL and a withdrawal
              of 7.31 SOL appears later, no cryptography is needed to link them. Fixed sizes mean
              every deposit in a pool looks the same. To move an amount that is not on the list,
              make several deposits.
            </p>
          </Question>

          <Question q="How long should I really wait?">
            <p>
              Longer is always better, and the useful unit is other people's deposits rather than
              time itself. Every deposit that arrives after yours is another candidate an observer
              has to consider. Waiting until a pool has seen more activity does more for you than
              anything else on the screen.
            </p>
          </Question>

          <Question q="What is a relayer and why is one involved?">
            <p>
              Withdrawing needs a transaction, and transactions cost a small fee. If your fresh
              destination wallet paid that fee, it would first need SOL from somewhere, and that
              transfer would point straight back at you.
            </p>
            <p>
              A relayer submits the transaction and takes its cost out of the withdrawal instead.
              It cannot change where the money goes or take more than the fee shown to you before
              you approve, because both are locked into the proof. Anyone can run one.
            </p>
          </Question>

          <Question q="Can I withdraw to the wallet I deposited from?">
            <p>
              You can, and the transaction will work, but it undoes the privacy entirely: both
              transactions then involve the same address. If you only want to move funds and do not
              care about privacy, an ordinary transfer is cheaper.
            </p>
          </Question>

          <Question q="Do I need my wallet to withdraw?">
            <p>
              No. Withdrawing needs only the note and a destination address. That is deliberate: it
              means you can withdraw from a device that has never held your wallet.
            </p>
          </Question>

          <Question q="Can I close the tab while it is working?">
            <p>
              Not during a withdrawal. The proof is computed in your browser, and closing the page
              throws away that work. Nothing is lost permanently, since the note stays unspent and
              you can start again, but you will wait through the proof a second time.
            </p>
          </Question>

          <Question q="Who can see what?">
            <p>
              On-chain, nobody can link your deposit to your withdrawal. Off-chain is different:
              the relayer sees the destination address and your IP, and your RPC provider sees your
              IP for both transactions. That is why the withdrawal advice is to change network and
              device.
            </p>
          </Question>

          <Question q="Is my money held by anyone?">
            <p>
              The funds sit in a contract-controlled account, and only a valid proof can move them.
              No administrator can take them or block a withdrawal. The honest caveat is that the
              program can still be upgraded by its author today, so trust is not yet removed from
              the picture, and the project says so openly rather than claiming otherwise.
            </p>
          </Question>
        </div>
      </section>

      <p className="text-zinc-600 text-xs text-center leading-relaxed">
        Still unsure? Try the smallest amount first, on devnet, and withdraw it. Reading about it is
        less convincing than watching it work.
      </p>
    </div>
  );
}
