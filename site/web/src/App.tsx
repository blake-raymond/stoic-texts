import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useLocalRuntime,
} from "@assistant-ui/react";
import {
  CANCEL_ANY_TIME,
  CHECKOUT_NOTE,
  CHECKOUT_UNAVAILABLE,
  CONTINUE_FOUNDING,
  CONTINUE_MONTHLY,
  CONTINUE_YEARLY,
  EMPTY_SUB,
  EMPTY_TITLE,
  FOUNDING_FULL,
  FOUNDING_LEAD,
  FREE_IDLE,
  MONTHLY_LABEL,
  NAME,
  NOT_NOW,
  PLACEHOLDER,
  PLAN_NOTE,
  RESTORE_CODE,
  RESTORE_CONFIRM,
  RESTORE_EMAIL,
  RESTORE_HELP,
  RESTORE_SEND,
  SEND,
  YEARLY_LABEL,
  YOU,
} from "./copy";
import { adapter, history, type AccessBlock } from "./runtime";

type AccessView = {
  ok?: boolean;
  tier?: "free" | "paid";
  replies_used?: number;
  replies_limit?: number;
  code?: string | null;
  message?: string | null;
  restore?: "email" | "help";
  portal?: boolean;
};

type Offer = {
  ok?: boolean;
  portal?: boolean;
  founding?: { remaining?: number } | null;
};

type PaidPlan = "yearly" | "monthly";

function sheetDismissed(): boolean {
  try {
    return sessionStorage.getItem("oc_sheet_off") === "1";
  } catch {
    return false;
  }
}

function trackCheckout(msOpen: number) {
  const oc = (window as unknown as {
    oldCounsel?: { track?: (name: string, props?: Record<string, unknown>) => void };
  }).oldCounsel;
  oc?.track?.("checkout_click", { cta: "chat", ms_open: Math.max(0, msOpen) });
  try {
    sessionStorage.setItem("oc_checkout", JSON.stringify({ cta: "chat" }));
  } catch {
    // The receipt page still loads.
  }
}

async function startCheckout(plan: string, msOpen: number): Promise<string> {
  trackCheckout(msOpen);
  const response = await fetch("/api/checkout", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ plan }),
  });
  const body = await response.json() as { url?: unknown; code?: unknown };
  if (typeof body.url === "string" && body.url) {
    window.location.assign(body.url);
    return "";
  }
  if (body.code === "founding_full") return FOUNDING_FULL;
  return CHECKOUT_UNAVAILABLE;
}

async function startPortal(): Promise<void> {
  const response = await fetch("/api/billing/portal", { method: "POST", credentials: "same-origin" });
  const body = await response.json() as { url?: unknown };
  if (typeof body.url === "string" && body.url) window.location.assign(body.url);
}

function statusLine(access: AccessView | null): string {
  if (!access || access.code || access.replies_limit === undefined || access.replies_used === undefined) return "";
  const left = Math.max(0, access.replies_limit - access.replies_used);
  if (access.tier === "paid") return `${left} of ${access.replies_limit} replies left this month.`;
  if (access.replies_used === 0) return FREE_IDLE;
  return `${left} replies left in this free conversation.`;
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="msg you">
      <p className="who">{YOU}</p>
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="msg oc">
      <MessagePrimitive.If hasContent>
        <p className="who">{NAME}</p>
      </MessagePrimitive.If>
      <MessagePrimitive.Parts />
      <MessagePrimitive.Error>
        <ErrorPrimitive.Root className="chat-error">
          <ErrorPrimitive.Message />
        </ErrorPrimitive.Root>
      </MessagePrimitive.Error>
    </MessagePrimitive.Root>
  );
}

function RestoreForm() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [note, setNote] = useState("");
  const [asked, setAsked] = useState(false);

  async function sendCode(event: FormEvent) {
    event.preventDefault();
    if (!email.trim()) {
      setNote("Enter the email from your purchase.");
      return;
    }
    const response = await fetch("/api/access/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ email }),
    });
    const body = await response.json() as { message?: string };
    setNote(body.message || RESTORE_HELP);
    if (response.ok) setAsked(true);
  }

  async function confirm(event: FormEvent) {
    event.preventDefault();
    const response = await fetch("/api/access/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ email, code }),
    });
    const body = await response.json() as { message?: string; done?: boolean };
    setNote(body.message || RESTORE_HELP);
    if (body.done) window.location.reload();
  }

  return (
    <div className="restore-form">
      <form noValidate onSubmit={sendCode}>
        <label className="sr" htmlFor="restore-email">{RESTORE_EMAIL}</label>
        <input
          className="field"
          id="restore-email"
          type="email"
          autoComplete="email"
          required
          placeholder={RESTORE_EMAIL}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <button className="cta" type="submit">{RESTORE_SEND}</button>
      </form>
      {asked ? (
        <form noValidate onSubmit={confirm}>
          <label className="sr" htmlFor="restore-code">{RESTORE_CODE}</label>
          <input
            className="field"
            id="restore-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            placeholder={RESTORE_CODE}
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <button className="cta" type="submit">{RESTORE_CONFIRM}</button>
        </form>
      ) : null}
      {note ? <p>{note}</p> : null}
    </div>
  );
}

function Paywall({ access, message }: { access: AccessView | null; message: string }) {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [plan, setPlan] = useState<PaidPlan>("yearly");
  const [dismissed, setDismissed] = useState(sheetDismissed);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const openedAt = useRef(Date.now());
  useEffect(() => {
    let gone = false;
    fetch("/api/offer", { credentials: "same-origin", cache: "no-store" })
      .then((response) => response.json())
      .then((body: Offer) => {
        if (!gone) setOffer(body);
      })
      .catch(() => {
        // Plans stay. Spots and cancel stay hidden without a real answer.
      });
    return () => {
      gone = true;
    };
  }, []);
  if (dismissed) {
    return (
      <div className="chat-panel" role="status">
        <p>{message}</p>
      </div>
    );
  }
  const remaining = offer?.founding?.remaining;
  const go = (chosen: string) => {
    setBusy(true);
    setNote("");
    startCheckout(chosen, Date.now() - openedAt.current)
      .then((problem) => {
        if (problem) setNote(problem);
      })
      .catch(() => setNote(CHECKOUT_UNAVAILABLE))
      .finally(() => setBusy(false));
  };
  return (
    <div className="chat-panel" role="status">
      <p>{message}</p>
      <fieldset className="plans">
        <legend>Plan</legend>
        <label>
          <input type="radio" name="plan" value="yearly" checked={plan === "yearly"} onChange={() => setPlan("yearly")} />
          {YEARLY_LABEL}
        </label>
        <label>
          <input type="radio" name="plan" value="monthly" checked={plan === "monthly"} onChange={() => setPlan("monthly")} />
          {MONTHLY_LABEL}
        </label>
      </fieldset>
      <p className="under">{PLAN_NOTE}</p>
      <button className="cta" type="button" disabled={busy} onClick={() => go(plan)}>
        {plan === "monthly" ? CONTINUE_MONTHLY : CONTINUE_YEARLY}
      </button>
      {offer?.portal ? <p className="under">{CANCEL_ANY_TIME}</p> : null}
      <p className="under">{CHECKOUT_NOTE}</p>
      {typeof remaining === "number" ? (
        <div className="founding-choice">
          <p>{FOUNDING_LEAD}</p>
          <p>{remaining === 1 ? "1 spot left" : `${remaining} spots left`}</p>
          <button className="text-button" type="button" disabled={busy} onClick={() => go("founding")}>
            {CONTINUE_FOUNDING}
          </button>
        </div>
      ) : null}
      {note ? <p>{note}</p> : null}
      <p>{RESTORE_HELP}</p>
      {access?.restore === "email" ? <RestoreForm /> : null}
      <button
        className="text-button"
        type="button"
        onClick={() => {
          try {
            sessionStorage.setItem("oc_sheet_off", "1");
          } catch {
            // This visit still closes the sheet.
          }
          setDismissed(true);
        }}
      >
        {NOT_NOW}
      </button>
    </div>
  );
}

function Dock({ access, block }: { access: AccessView | null; block: AccessBlock | null }) {
  if ((block?.code === "free_limit" || block?.code === "inactive") && block.message) {
    return <Paywall access={access} message={block.message} />;
  }
  if (block?.code === "monthly_cap") {
    return (
      <div className="chat-panel" role="status">
        <p>{block.message}</p>
      </div>
    );
  }
  return (
    <ComposerPrimitive.Root>
      <ComposerPrimitive.Input className="field" placeholder={PLACEHOLDER} autoFocus rows={3} />
      <ComposerPrimitive.Send className="cta">{SEND}</ComposerPrimitive.Send>
    </ComposerPrimitive.Root>
  );
}

function Shell() {
  const [access, setAccess] = useState<AccessView | null>(null);
  const [block, setBlock] = useState<AccessBlock | null>(null);

  useEffect(() => {
    let gone = false;
    fetch("/api/access", { credentials: "same-origin", cache: "no-store" })
      .then((response) => response.json())
      .then((body: AccessView) => {
        if (gone) return;
        setAccess(body);
        if ((body.code === "free_limit" || body.code === "monthly_cap" || body.code === "inactive") && body.message) {
          setBlock({ code: body.code, message: body.message });
        }
      })
      .catch(() => {
        // The composer still tries. The server answers if it can.
      });
    const onBlock = (event: Event) => {
      const detail = (event as CustomEvent<AccessBlock>).detail;
      if (detail?.code !== "free_limit" && detail?.code !== "monthly_cap" && detail?.code !== "inactive") return;
      // The click that hit Send is still in flight. Wait so it does not land on the panel.
      window.setTimeout(() => setBlock(detail), 250);
    };
    const onReplied = () => {
      fetch("/api/access", { credentials: "same-origin", cache: "no-store" })
        .then((response) => response.json())
        .then((body: AccessView) => {
          if (gone) return;
          setAccess(body);
          if ((body.code === "free_limit" || body.code === "monthly_cap" || body.code === "inactive") && body.message) {
            setBlock({ code: body.code, message: body.message });
          }
        })
        .catch(() => {
          // The next send still hits the server.
        });
    };
    window.addEventListener("oc-block", onBlock);
    window.addEventListener("oc-replied", onReplied);
    return () => {
      gone = true;
      window.removeEventListener("oc-block", onBlock);
      window.removeEventListener("oc-replied", onReplied);
    };
  }, []);

  const status = statusLine(block ? null : access);

  return (
    <>
      <header className="top">
        <div className="wrap">
          <a className="mark" href="/">Old Counsel</a>
          {status ? <p className="chat-status">{status}</p> : null}
          {access?.tier === "paid" && access.portal && !block ? (
            <button className="text-button" type="button" onClick={() => { void startPortal(); }}>{CANCEL_ANY_TIME}</button>
          ) : null}
        </div>
      </header>
      <ThreadPrimitive.Root className="chat-thread">
        <ThreadPrimitive.Viewport className="chat-log" autoScroll>
          <div className="wrap">
            <ThreadPrimitive.Empty>
              <div className="chat-empty">
                <p className="eyebrow">Talk to the Stoics</p>
                <h1>{EMPTY_TITLE}</h1>
                <p className="lede">{EMPTY_SUB}</p>
              </div>
            </ThreadPrimitive.Empty>
            <ThreadPrimitive.Messages>
              {({ message }) => (message.role === "user" ? <UserMessage /> : <AssistantMessage />)}
            </ThreadPrimitive.Messages>
          </div>
          <ThreadPrimitive.ViewportFooter className="chat-dock">
            <div className="wrap">
              <Dock access={access} block={block} />
            </div>
          </ThreadPrimitive.ViewportFooter>
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </>
  );
}

export function App() {
  const runtime = useLocalRuntime(adapter, { adapters: { history } });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Shell />
    </AssistantRuntimeProvider>
  );
}
