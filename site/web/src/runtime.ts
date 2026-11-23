import {
  type ChatModelAdapter,
  type ThreadHistoryAdapter,
  type ThreadMessage,
} from "@assistant-ui/react";

const HISTORY_KEY = "oc_chat_history";

export type AccessBlock = {
  code: string;
  message: string;
};

type StoredRepo = {
  messages: Array<{
    message: ThreadMessage;
    parentId: string | null;
  }>;
};

function textOf(message: ThreadMessage): string {
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
    .trim();
}

function readHistory(): StoredRepo {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return { messages: [] };
    const parsed = JSON.parse(raw) as StoredRepo;
    if (!parsed || !Array.isArray(parsed.messages)) return { messages: [] };
    return {
      messages: parsed.messages.map((item) => ({
        ...item,
        message: {
          ...item.message,
          createdAt: new Date(item.message.createdAt),
        },
      })),
    };
  } catch {
    return { messages: [] };
  }
}

function writeHistory(item: { message: ThreadMessage; parentId: string | null }) {
  try {
    const current = readHistory();
    const messages = current.messages.filter((entry) => entry.message.id !== item.message.id);
    messages.push(item);
    const raw = JSON.stringify({ messages });
    if (raw.length > 2_000_000) return;
    localStorage.setItem(HISTORY_KEY, raw);
  } catch {
    // The conversation still works for this visit.
  }
}

export const history: ThreadHistoryAdapter = {
  async load() {
    return readHistory();
  },
  async append(item) {
    writeHistory(item);
  },
  async update(item) {
    writeHistory(item);
  },
};

export const adapter: ChatModelAdapter = {
  async *run({ messages, abortSignal }) {
    const turns = messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({ role: message.role, content: textOf(message) }))
      .filter((message) => message.content.length > 0);
    let response: Response;
    try {
      response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ messages: turns }),
        signal: abortSignal,
      });
    } catch (error) {
      if (abortSignal.aborted) return;
      throw error;
    }
    if (!response.ok) {
      let message = "Something went wrong before a reply came back. Try again in a moment.";
      let code = "";
      try {
        const body = await response.json() as { message?: unknown; code?: unknown };
        if (typeof body.message === "string" && body.message) message = body.message;
        if (typeof body.code === "string") code = body.code;
      } catch {
        // The status is enough.
      }
      if (code === "free_limit" || code === "monthly_cap" || code === "inactive") {
        window.dispatchEvent(new CustomEvent<AccessBlock>("oc-block", { detail: { code, message } }));
      }
      throw new Error(message);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Something went wrong before a reply came back. Try again in a moment.");
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    const take = (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        const parsed = JSON.parse(data) as { delta?: unknown; error?: unknown };
        if (typeof parsed.error === "string") throw new Error(parsed.error);
        if (typeof parsed.delta === "string" && parsed.delta) text += parsed.delta;
      }
    };
    while (true) {
      const step = await reader.read();
      if (step.done) break;
      take(decoder.decode(step.value, { stream: true }));
      if (text) yield { content: [{ type: "text", text }] };
    }
    take(decoder.decode());
    if (text) {
      yield { content: [{ type: "text", text }] };
      window.dispatchEvent(new Event("oc-replied"));
    }
  },
};
