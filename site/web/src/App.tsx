import { useEffect, useState, type FormEvent } from "react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useLocalRuntime,
} from "@assistant-ui/react";
import { PAYMENT_LINK } from "../../src/public-config";
import {
  CHECKOUT,
  CHECKOUT_NOTE,
  EMPTY_SUB,
  EMPTY_TITLE,
  FREE_IDLE,
  NAME,
  PAYWALL_TITLE,
  PLACEHOLDER,
  RESTORE_CODE,
  RESTORE_CONFIRM,
  RESTORE_EMAIL,
  RESTORE_HELP,
  RESTORE_SEND,
  SEND,
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
};

function checkoutHref(): string {
  let variant = "a";
  try {
    const stored = localStorage.getItem("oc_v");
    if (stored === "b" || stored === "c") variant = stored;
  } catch {
    // The default variant is fine.
  }
  return `${PAYMENT_LINK}?client_reference_id=${encodeURIComponent(`chat_${variant}`)}`;
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

function Dock({ access, block }: { access: AccessView | null; block: AccessBlock | null }) {
  if (block?.code === "free_limit") {
    return (
      <div className="chat-panel" role="status">
        <h2>{PAYWALL_TITLE}</h2>
        <p>{block.message}</p>
        <a className="cta" href={checkoutHref()}>{CHECKOUT}</a>
        <p className="under">{CHECKOUT_NOTE}</p>
        <p>{RESTORE_HELP}</p>
        {access?.restore === "email" ? <RestoreForm /> : null}
      </div>
    );
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
        if ((body.code === "free_limit" || body.code === "monthly_cap") && body.message) {
          setBlock({ code: body.code, message: body.message });
        }
      })
      .catch(() => {
        // The composer still tries. The server answers if it can.
      });
    const onBlock = (event: Event) => {
      const detail = (event as CustomEvent<AccessBlock>).detail;
      if (detail?.code !== "free_limit" && detail?.code !== "monthly_cap") return;
      // The click that hit Send is still in flight. Wait so it does not land on the panel.
      window.setTimeout(() => setBlock(detail), 250);
    };
    const onReplied = () => {
      fetch("/api/access", { credentials: "same-origin", cache: "no-store" })
        .then((response) => response.json())
        .then((body: AccessView) => {
          if (gone) return;
          setAccess(body);
          if ((body.code === "free_limit" || body.code === "monthly_cap") && body.message) {
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
